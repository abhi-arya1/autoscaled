import { DurableObject } from "cloudflare:workers";
import {
    getContainer as getContainerInstance,
    Container,
    type State,
} from "@cloudflare/containers";
import { nanoid } from "nanoid";

const AUTOSCALER_STUB_NAME = "main";

export type GenericContainer<T = unknown> = Container<T>;
export type ContainerStub<T = unknown> = DurableObjectStub<GenericContainer<T>>;
export type ContainerNamespace<T = unknown> = DurableObjectNamespace<
    GenericContainer<T>
>;

export type MonitorzData = {
    // Percentages on a 0-100 scale
    cpu_usage: number;
    memory_usage: number;
    disk_usage: number;
};

interface InstanceRecord extends Record<string, string | number | null> {
    name: string;
    created_at: string; // ISO 8601
    active_requests: number;
    current_cpu: number; // vCPU
    current_memory_MiB: number; // MB
    current_disk_GB: number; // GB
    healthy: 0 | 1;
    last_heartbeat: string; // ISO 8601
    last_request_at: string; // ISO 8601
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
    /**
     * The instance type, to account for compute constraints of a container
     * @default "standard-1"
     */
    instance: InstanceType;
    /**
     * The *required* Workers Binding to your container class from wrangler.jsonc/toml
     * This is marked as optional solely for development purposes.
     */
    containerBinding?: ContainerNamespace;
    /**
     * The maximum number of containers that can run
     * @default 10
     */
    maxInstances: number;
    /**
     * The minimum number of containers that should be running
     * @default 0
     */
    minInstances?: number;
    /**
     * The maximum number of requests that a container can handle at once before it is considered overloaded
     * This is optional and will be ignored if not provided.
     */
    maxRequestsPerInstance?: number;
    /**
     * The interval at which the autoscaler will check for stale or unhealthy instances
     * @default 30_000 (milliseconds)
     */
    heartbeatInterval?: number;
    /**
     * The threshold for considering an instance stale (i.e. last request was more than this threshold ago)
     * @default 120_000 (milliseconds, i.e. 2 minutes)
     */
    staleThreshold?: number;
    /**
     * The specific CPU percentage threshold for scaling up a new instance
     */
    scaleThesholdCPU?: number;
    /**
     * The specific memory usage percentage threshold for scaling up a new instance
     */
    scaleThesholdMemoryMiB?: number;
    /**
     * The specific disk usage percentage threshold for scaling up a new instance
     */
    scaleThesholdDiskGB?: number;
    /**
     * The overall threshold for scaling up a new instance
     * You can either use this to control all at once, or use the specific thresholds above to control each metric individually.
     * @default 75 (Percent)
     */
    scaleThreshold?: number;
    /**
     * The endpoint to monitor the autoscaler's health
     * @default "/healthz"
     */
    monitoringEndpoint?: string;
    /**
     * The endpoint to fetch container compute monitoring from
     * @default "http://localhost:81/monitorz"
     */
    monitorzURL?: string;
}

export const routeContainerRequest = async (
    request: Request,
    binding: DurableObjectNamespace<undefined>,
) => {
    try {
        const autoscalerId = binding.idFromName(AUTOSCALER_STUB_NAME);
        const instance = binding.get(autoscalerId);

        return await instance.fetch(request);
    } catch (error: unknown) {
        console.error(error);
        return new Response("Internal Server Error", { status: 500 });
    }
};

export class Autoscaler<Env> extends DurableObject<Env> {
    config: AutoscalerConfig = {
        instance: "standard-1",
        maxInstances: 10,
        minInstances: 1,
        heartbeatInterval: 30_000,
        staleThreshold: 120_000,
        monitoringEndpoint: "/healthz",
        scaleThreshold: 75,
        monitorzURL: "http://localhost:81/monitorz",
    };

    #hasSpecificThresholds: boolean = false;
    #hasAllSpecificThresholds: boolean = false;

    protected get containerBinding(): ContainerNamespace {
        if (!this.config.containerBinding) {
            throw new Error(
                "containerBinding must be provided in config. Override config in your subclass.",
            );
        }
        return this.config.containerBinding;
    }

    #getISO8601Now(): string {
        return new Date().toISOString();
    }

    #getContainerName(container: ContainerStub<Env>): string {
        return container.name || container.id.toString();
    }

    #isHealthy(state: State): boolean {
        return state.status === "running" || state.status === "healthy";
    }

    async #getHealthz(): Promise<{
        instanceCount: number;
        instances: InstanceRecord[];
    }> {
        const instanceCount = await this.getInstanceCount();
        const instances = this.ctx.storage.sql
            .exec<InstanceRecord>(`SELECT * FROM instances`)
            .toArray();

        return {
            instanceCount,
            instances,
        };
    }

    async #removeInstance(
        container: ContainerStub<Env>,
        destroy: boolean = true,
    ): Promise<void> {
        try {
            if (destroy) {
                await container.destroy();
            }

            this.ctx.storage.sql.exec(
                `DELETE FROM instances WHERE name = ?`,
                this.#getContainerName(container),
            );
        } catch (error) {
            console.error("Error removing instance:", error);
        }
    }

    async #fetchMonitorz(container: ContainerStub<Env>): Promise<MonitorzData> {
        const url = this.config.monitorzURL ?? "http://localhost:81/monitorz";
        const response = await container.containerFetch(url);

        if (!response.ok) {
            throw new Error(
                `Failed to fetch monitorz data: ${response.status}`,
            );
        }

        // Server now returns numbers directly, no transformation needed
        const data = (await response.json()) as MonitorzData;
        return data;
    }

    async #updateInstanceMetrics(): Promise<void> {
        // Fetch all instances from database
        const cursor = this.ctx.storage.sql.exec<InstanceRecord>(
            `SELECT name FROM instances WHERE healthy = 1`,
        );
        const instances = cursor.toArray();

        if (instances.length === 0) {
            return; // No instances to update
        }

        // Update metrics for each instance
        for (const instance of instances) {
            try {
                const container = this.containerBinding.getByName(
                    instance.name,
                );
                const monitorzData = await this.#fetchMonitorz(container);

                // Update database with current metrics (stored as percentages)
                this.ctx.storage.sql.exec(
                    `UPDATE instances SET 
                        current_cpu = ?,
                        current_memory_MiB = ?,
                        current_disk_GB = ?
                     WHERE name = ?`,
                    monitorzData.cpu_usage,
                    monitorzData.memory_usage,
                    monitorzData.disk_usage,
                    instance.name,
                );
            } catch (error) {
                // Log error but continue with other instances
                console.error(
                    `Error updating metrics for instance ${instance.name}:`,
                    error,
                );
            }
        }
    }

    async #shouldScaleUp(): Promise<boolean> {
        // Check if we're already at max instances
        const currentCount = await this.getInstanceCount();
        if (currentCount >= this.config.maxInstances) {
            return false;
        }

        // If no thresholds configured, don't scale up based on metrics
        if (!this.#hasSpecificThresholds && !this.config.scaleThreshold) {
            return false;
        }

        // Fetch all instances with their current metrics
        const cursor = this.ctx.storage.sql.exec<InstanceRecord>(
            `SELECT current_cpu, current_memory_MiB, current_disk_GB FROM instances WHERE healthy = 1`,
        );
        const instances = cursor.toArray();

        if (instances.length === 0) {
            return false; // No instances to check
        }

        // Check if any instance exceeds thresholds
        for (const instance of instances) {
            if (this.#hasAllSpecificThresholds) {
                // Use specific thresholds for each metric
                const cpuThreshold = this.config.scaleThesholdCPU ?? 0;
                const memoryThreshold = this.config.scaleThesholdMemoryMiB ?? 0;
                const diskThreshold = this.config.scaleThesholdDiskGB ?? 0;

                if (
                    instance.current_cpu > cpuThreshold ||
                    instance.current_memory_MiB > memoryThreshold ||
                    instance.current_disk_GB > diskThreshold
                ) {
                    return true; // At least one threshold exceeded
                }
            } else if (this.config.scaleThreshold !== undefined) {
                // Use general threshold for all metrics
                const generalThreshold = this.config.scaleThreshold;

                if (
                    instance.current_cpu > generalThreshold ||
                    instance.current_memory_MiB > generalThreshold ||
                    instance.current_disk_GB > generalThreshold
                ) {
                    return true; // At least one metric exceeds general threshold
                }
            }
        }

        return false; // No thresholds exceeded
    }

    async #scaleUpIfNeeded(): Promise<void> {
        const shouldScale = await this.#shouldScaleUp();

        if (!shouldScale) {
            return; // No scaling needed
        }

        try {
            const container = await this.createNewInstance();
            const state = await container.getState();
            await this.beforeRequest(container, state, 0);
            console.log(
                `Scaled up: Created new instance ${this.#getContainerName(container)}`,
            );
        } catch (error) {
            console.error("Error scaling up:", error);
            // Don't throw - allow scale-down to proceed even if scale-up fails
        }
    }

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        const hasSpecificThresholds =
            this.config.scaleThesholdCPU !== undefined ||
            this.config.scaleThesholdMemoryMiB !== undefined ||
            this.config.scaleThesholdDiskGB !== undefined;

        const hasAllSpecificThresholds =
            this.config.scaleThesholdCPU !== undefined &&
            this.config.scaleThesholdMemoryMiB !== undefined &&
            this.config.scaleThesholdDiskGB !== undefined;

        if (
            hasAllSpecificThresholds &&
            this.config.scaleThreshold !== undefined
        ) {
            console.warn(
                "scaleThreshold will not be used when all specific thresholds (scaleThesholdCPU, scaleThesholdMemoryMiB, scaleThesholdDiskGB) are provided.",
            );
        }

        if (hasSpecificThresholds && !hasAllSpecificThresholds) {
            const missing = [];
            if (this.config.scaleThesholdCPU === undefined)
                missing.push("scaleThesholdCPU");
            if (this.config.scaleThesholdMemoryMiB === undefined)
                missing.push("scaleThesholdMemoryMiB");
            if (this.config.scaleThesholdDiskGB === undefined)
                missing.push("scaleThesholdDiskGB");
            console.warn(
                `Autoscaling will not respond to: ${missing.join(", ")}. Provide all three specific thresholds for complete autoscaling.`,
            );
        }

        this.#hasSpecificThresholds = hasSpecificThresholds;
        this.#hasAllSpecificThresholds = hasAllSpecificThresholds;

        ctx.blockConcurrencyWhile(async () => {
            await this.migrate();
            await this.scheduleAlarm();
            await this.warmUpInstances();
        });
    }

    private async scheduleAlarm(): Promise<void> {
        const nextAlarm =
            Date.now() + (this.config.heartbeatInterval || 30_000);
        await this.ctx.storage.setAlarm(nextAlarm);
    }

    override async alarm(): Promise<void> {
        // Update metrics from all instances
        await this.#updateInstanceMetrics();

        // Scale up if thresholds are exceeded
        await this.#scaleUpIfNeeded();

        // Scale down stale/unhealthy instances
        await this.cleanupAndScaleDown();

        // Schedule next alarm
        await this.scheduleAlarm();
    }

    private async warmUpInstances(): Promise<void> {
        const minInstances = this.config.minInstances ?? 0;
        for (let i = 0; i < minInstances; i++) {
            const container = await this.createNewInstance();
            this.ctx.waitUntil(container.startAndWaitForPorts());
            await this.beforeRequest(container, await container.getState(), 0);
        }
    }

    private async beforeRequest(
        container: ContainerStub<Env>,
        state: State,
        initialActiveRequests: number = 1,
    ): Promise<void> {
        const now = this.#getISO8601Now();
        const healthy = this.#isHealthy(state) ? 1 : 0;

        this.ctx.storage.sql.exec(
            `INSERT INTO instances (name, created_at, active_requests, current_cpu, current_memory_MiB, current_disk_GB, last_heartbeat, healthy)
             VALUES (?, ?, ?, 0, 0, 0, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
                 active_requests = active_requests + 1,
                 last_heartbeat = ?,
                 healthy = ?,
                 current_cpu = current_cpu,
                 current_memory_MiB = current_memory_MiB,
                 current_disk_GB = current_disk_GB`,
            this.#getContainerName(container),
            now,
            initialActiveRequests,
            now,
            healthy,
            now,
            healthy,
        );
    }

    private async afterRequest(container: ContainerStub<Env>): Promise<void> {
        this.ctx.storage.sql.exec(
            `UPDATE instances SET 
                active_requests = MAX(0, active_requests - 1),
                last_request_at = ?
             WHERE name = ?`,
            this.#getISO8601Now(),
            this.#getContainerName(container),
        );
    }

    private async getInstanceCount(
        healthyOnly: boolean = true,
    ): Promise<number> {
        const cursor = this.ctx.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) as count FROM instances ${healthyOnly ? "WHERE healthy = 1" : ""}`,
        );
        const result = cursor.toArray();
        return result[0]?.count ?? 0;
    }

    private async createNewInstance(): Promise<ContainerStub<Env>> {
        const count = await this.getInstanceCount();
        if (count >= this.config.maxInstances) {
            throw new Error(
                `Max instances (${this.config.maxInstances}) reached. Cannot create new container.`,
            );
        }

        const container = getContainerInstance(this.containerBinding, nanoid());
        await container.startAndWaitForPorts();
        return container;
    }

    private async replaceInstance(
        container: ContainerStub<Env>,
    ): Promise<{ container: ContainerStub<Env>; state: State }> {
        await this.#removeInstance(container);
        const newContainer = await this.createNewInstance();
        await newContainer.startAndWaitForPorts();

        return {
            container: newContainer,
            state: await newContainer.getState(),
        };
    }

    private async getLeastLoadedContainer(): Promise<{
        container: ContainerStub<Env>;
        state: State;
    }> {
        const cursor = this.ctx.storage.sql.exec<InstanceRecord>(`
            SELECT * FROM instances 
            WHERE healthy = 1
            ORDER BY 
                active_requests ASC,
                last_heartbeat DESC
            LIMIT 1;
        `);

        const result = cursor.toArray();

        if (result.length === 0 || !result[0]) {
            try {
                const container = await this.createNewInstance();
                const state = await container.getState();
                return { container, state };
            } catch (error) {
                const fallbackCursor = this.ctx.storage.sql
                    .exec<InstanceRecord>(`
                    SELECT * FROM instances 
                    ORDER BY active_requests ASC, last_heartbeat DESC
                    LIMIT 1;
                `);
                const fallbackResult = fallbackCursor.toArray();
                if (fallbackResult.length > 0 && fallbackResult[0]) {
                    const container = this.containerBinding.getByName(
                        fallbackResult[0].name,
                    );
                    const state = await container.getState();
                    return { container, state };
                }
                throw error;
            }
        }

        const container = this.containerBinding.getByName(result[0].name);
        const state = await container.getState();

        if (this.#isHealthy(state)) {
            return { container, state };
        } else {
            try {
                const container = await this.createNewInstance();
                const state = await container.getState();
                return { container, state };
            } catch (error) {
                console.warn(
                    "All instances are unhealthy. Replacing the least loaded unhealthy instance.",
                );
                const newInstance = await this.replaceInstance(container);
                return newInstance;
            }
        }
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (
            url.pathname === this.config.monitoringEndpoint &&
            request.method === "GET"
        ) {
            const healthz = await this.#getHealthz();
            return new Response(JSON.stringify(healthz), { status: 200 });
        }

        try {
            const { container, state } = await this.getLeastLoadedContainer();

            await this.beforeRequest(container, state);

            try {
                const response = await container.fetch(request);

                this.ctx.waitUntil(
                    this.afterRequest(container).catch((err) => {
                        console.error("Error after request:", err);
                    }),
                );

                return response;
            } catch (error) {
                // Ensure decrement happens even on error
                this.ctx.waitUntil(
                    this.afterRequest(container).catch((err) => {
                        console.error("Error after request:", err);
                    }),
                );
                throw error;
            }
        } catch (error) {
            console.error("Error routing request:", error);
            return new Response("Internal Server Error", { status: 500 });
        }
    }

    private async cleanupAndScaleDown(): Promise<void> {
        const staleThreshold = new Date(
            Date.now() - (this.config.staleThreshold || 120_000),
        ).toISOString();
        const minInstances = this.config.minInstances ?? 1;
        const currentCount = await this.getInstanceCount();

        // Find stale or unhealthy instances
        const cursor = this.ctx.storage.sql.exec<InstanceRecord>(
            `SELECT name FROM instances WHERE last_heartbeat < ? OR healthy = 0`,
            staleThreshold,
        );
        const results = cursor.toArray();

        const instancesToRemove = Math.min(
            results.length,
            Math.max(0, currentCount - minInstances),
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

            this.ctx.storage.sql.exec(
                `DELETE FROM instances WHERE name = ?`,
                row.name,
            );
        }
    }

    async migrate(): Promise<void> {
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS instances (
                name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                active_requests INTEGER NOT NULL,
                current_cpu REAL NOT NULL,
                current_memory_MiB INTEGER NOT NULL,
                current_disk_GB INTEGER NOT NULL,
                healthy INTEGER DEFAULT 1,
                last_heartbeat TEXT NOT NULL,
                last_request_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_instances_healthy_ordering 
            ON instances(healthy, active_requests, last_heartbeat)
        `);
    }
}
