import { DurableObject } from "cloudflare:workers";
import { getContainer, Container, type State } from "@cloudflare/containers";
import { nanoid } from "nanoid";

interface InstanceRecord extends Record<string, string | number | null> {
    name: string;
    created_at: string; // ISO 8601
    pending_requests: number;
    current_cpu: number; // vCPU
    current_memory_MiB: number; // MB
    current_disk_GB: number; // GB
    healthy: 0 | 1;
    last_heartbeat: string; // ISO 8601
}

export type InstanceType =
    | "lite"
    | "basic"
    | "standard-1"
    | "standard-2"
    | "standard-3"
    | "standard-4"
    | "dev" // Alias for "lite" (backward compatibility)
    | "standard"; // Alias for "standard-1" (backward compatibility)

export interface Instance {
    type: InstanceType;
    vCPU: number;
    memoryMiB: number;
    diskGB: number;
}

export const INSTANCE_SPECS: Record<InstanceType, Instance> = {
    lite: {
        type: "lite",
        vCPU: 1 / 16,
        memoryMiB: 256,
        diskGB: 2,
    },
    basic: {
        type: "basic",
        vCPU: 1 / 4,
        memoryMiB: 1024,
        diskGB: 4,
    },
    "standard-1": {
        type: "standard-1",
        vCPU: 1 / 2,
        memoryMiB: 4096,
        diskGB: 8,
    },
    "standard-2": {
        type: "standard-2",
        vCPU: 1,
        memoryMiB: 6144,
        diskGB: 12,
    },
    "standard-3": {
        type: "standard-3",
        vCPU: 2,
        memoryMiB: 8192,
        diskGB: 16,
    },
    "standard-4": {
        type: "standard-4",
        vCPU: 4,
        memoryMiB: 12288,
        diskGB: 20,
    },
    dev: {
        type: "dev",
        vCPU: 1 / 16,
        memoryMiB: 256,
        diskGB: 2,
    },
    standard: {
        type: "standard",
        vCPU: 1 / 2,
        memoryMiB: 4096,
        diskGB: 8,
    },
};

export interface AutoscalerConfig {
    instance: InstanceType;
    containerBinding?: DurableObjectNamespace<Container<unknown>>;
    maxInstances: number;
    minInstances?: number;
    maxRequestsPerInstance?: number;
}

export class Autoscaler<Env> extends DurableObject<Env> {
    config: AutoscalerConfig = {
        instance: "standard-1",
        maxInstances: 10,
        minInstances: 1,
    };

    protected get containerBinding(): DurableObjectNamespace<
        Container<unknown>
    > {
        if (!this.config.containerBinding) {
            throw new Error(
                "containerBinding must be provided in config. Override config in your subclass.",
            );
        }
        return this.config.containerBinding;
    }

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        ctx.blockConcurrencyWhile(async () => {
            await this.migrate();
            await this.scheduleAlarm();
        });
    }

    private async scheduleAlarm(): Promise<void> {
        const nextAlarm = Date.now() + 30_000; // every 30s
        await this.ctx.storage.setAlarm(nextAlarm);
    }

    override async alarm(): Promise<void> {
        await this.cleanupAndScaleDown();
        await this.scheduleAlarm();
    }

    private async incrementPendingRequests(name: string): Promise<void> {
        const now = new Date().toISOString();
        await this.ctx.storage.sql.exec(
            `INSERT INTO instances (name, created_at, pending_requests, current_cpu, current_memory_MiB, current_disk_GB, last_heartbeat, healthy)
             VALUES (?, ?, 1, 0, 0, 0, ?, 1)
             ON CONFLICT(name) DO UPDATE SET
                 pending_requests = pending_requests + 1,
                 last_heartbeat = ?`,
            [name, now, now, now]
        );
    }

    private async decrementPendingRequests(name: string): Promise<void> {
        await this.ctx.storage.sql.exec(
            `UPDATE instances SET pending_requests = MAX(0, pending_requests - 1)
             WHERE name = ?`,
            [name]
        );
    }

    private async getInstanceCount(): Promise<number> {
        const cursor = this.ctx.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) as count FROM instances WHERE healthy = 1`
        );
        const result = cursor.toArray();
        return result[0]?.count ?? 0;
    }

    private async createNewContainer(): Promise<
        DurableObjectStub<Container<Env>>
    > {
        const count = await this.getInstanceCount();
        if (count >= this.config.maxInstances) {
            throw new Error(
                `Max instances (${this.config.maxInstances}) reached. Cannot create new container.`
            );
        }

        const container = getContainer(this.containerBinding, nanoid());
        await container.startAndWaitForPorts();
        return container;
    }

    private async getLeastLoadedContainer(): Promise<
        [DurableObjectStub<Container<Env>>, State]
    > {
        const cursor = this.ctx.storage.sql.exec<InstanceRecord>(`
            SELECT * FROM instances 
            WHERE healthy = 1
            ORDER BY 
                pending_requests ASC,
                last_heartbeat DESC
            LIMIT 1;
        `);

        const result = cursor.toArray();

        if (result.length === 0 || !result[0]) {
            try {
                const container = await this.createNewContainer();
                const state = await container.getState();
                return [container, state];
            } catch (error) {
                const fallbackCursor = this.ctx.storage.sql.exec<InstanceRecord>(`
                    SELECT * FROM instances 
                    ORDER BY pending_requests ASC, last_heartbeat DESC
                    LIMIT 1;
                `);
                const fallbackResult = fallbackCursor.toArray();
                if (fallbackResult.length > 0 && fallbackResult[0]) {
                    const binding = this.containerBinding.getByName(fallbackResult[0].name);
                    const state = await binding.getState();
                    return [binding, state];
                }
                throw error;
            }
        }

        const binding = this.containerBinding.getByName(result[0].name);
        const state = await binding.getState();

        if (state.status === "running" || state.status === "healthy") {
            return [binding, state];
        } else {
            try {
                const container = await this.createNewContainer();
                const newState = await container.getState();
                return [container, newState];
            } catch (error) {
                // If maxInstances reached, return the unhealthy instance anyway
                return [binding, state];
            }
        }
    }

    override async fetch(request: Request): Promise<Response> {
        try {
            const [container, state] = await this.getLeastLoadedContainer();
            const containerName = container.name || container.id.toString();

            await this.incrementPendingRequests(containerName);

            const updatePromise = this.updateStatus(container, state);
            this.ctx.waitUntil(updatePromise);

            try {
                const response = await container.fetch(request);
                // Decrement after response completes (fire-and-forget)
                this.ctx.waitUntil(
                    this.decrementPendingRequests(containerName).catch((err) => {
                        console.error("Error decrementing pending requests:", err);
                    })
                );
                return response;
            } catch (error) {
                // Ensure decrement happens even on error
                this.ctx.waitUntil(
                    this.decrementPendingRequests(containerName).catch((err) => {
                        console.error("Error decrementing pending requests:", err);
                    })
                );
                throw error;
            }
        } catch (error) {
            console.error("Error routing request:", error);
            return new Response("Internal Server Error", { status: 500 });
        }
    }

    private async cleanupAndScaleDown(): Promise<void> {
        const staleThreshold = new Date(Date.now() - 120_000).toISOString(); // 2 min
        const minInstances = this.config.minInstances ?? 1;
        const currentCount = await this.getInstanceCount();

        // Find stale or unhealthy instances
        const cursor = this.ctx.storage.sql.exec<InstanceRecord>(
            `SELECT name FROM instances WHERE last_heartbeat < ? OR healthy = 0`,
            [staleThreshold]
        );
        const results = cursor.toArray();

        // Calculate how many instances we can remove without going below minInstances
        // After removing stale instances, we'll have currentCount healthy instances left
        // We need at least minInstances, so we can remove: max(0, currentCount - minInstances) instances
        // But we can't remove more than the number of stale instances available
        const instancesToRemove = Math.min(
            results.length,
            Math.max(0, currentCount - minInstances)
        );

        for (let i = 0; i < instancesToRemove; i++) {
            const row = results[i];
            if (!row) continue;

            try {
                const stub = this.containerBinding.getByName(row.name);
                await stub.stop().catch(() => {
                    // Best effort - ignore errors
                });
            } catch (error) {
                // Best effort - ignore errors
            }

            await this.ctx.storage.sql.exec(`DELETE FROM instances WHERE name = ?`, [row.name]);
        }
    }

    private async updateStatus(container: DurableObjectStub<Container<Env>>, state: State): Promise<void> {
        const name = container.name || container.id.toString();
        const now = new Date().toISOString();
        
        // Determine health based on actual container state
        const healthy = state.status === "running" || state.status === "healthy" ? 1 : 0;
        
        await this.ctx.storage.sql.exec(`
            INSERT INTO instances (
                name, 
                created_at, 
                pending_requests, 
                current_cpu, 
                current_memory_MiB, 
                current_disk_GB, 
                healthy, 
                last_heartbeat
            ) VALUES (?, ?, 0, 0, 0, 0, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                last_heartbeat = ?,
                healthy = ?,
                current_cpu = 0,
                current_memory_MiB = 0,
                current_disk_GB = 0
        `, [name, now, healthy, now, now, healthy]);
    }

    async migrate(): Promise<void> {
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS instances (
                name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                pending_requests INTEGER NOT NULL,
                current_cpu REAL NOT NULL,
                current_memory_MiB INTEGER NOT NULL,
                current_disk_GB INTEGER NOT NULL,
                healthy INTEGER DEFAULT 1,
                last_heartbeat TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_instances_healthy_ordering 
            ON instances(healthy, pending_requests, last_heartbeat)
        `);
    }
}
