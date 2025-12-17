import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type {
    InstanceRecord,
    InstanceFilter,
    CapacityInfo,
    ScalingState,
} from "./types.js";

export class AutoscalerState {
    constructor(
        private sql: DurableObjectStorage["sql"],
        private getNow: () => string,
    ) {}

    recordInstance(
        name: string,
        initialRequests: number,
        healthy: boolean,
        now: string,
    ): { previousRequests: number } {
        const healthyValue = healthy ? 1 : 0;
        const cursor = this.sql.exec<{ prev_requests: number }>(
            `INSERT INTO instances (name, created_at, active_requests, current_cpu, current_memory_MiB, current_disk_GB, last_heartbeat, last_request_at, healthy, draining, health_check_failures)
             VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, 0, 0)
             ON CONFLICT(name) DO UPDATE SET
                 active_requests = active_requests + ?,
                 last_heartbeat = ?,
                 last_request_at = ?,
                 healthy = ?,
                 current_cpu = COALESCE(current_cpu, 0),
                 current_memory_MiB = COALESCE(current_memory_MiB, 0),
                 current_disk_GB = COALESCE(current_disk_GB, 0)
             RETURNING active_requests - ? as prev_requests`,
            name,
            now,
            initialRequests,
            now,
            now,
            healthyValue,
            initialRequests,
            now,
            now,
            healthyValue,
            initialRequests,
        );

        const result = cursor.toArray();
        return { previousRequests: result[0]?.prev_requests ?? 0 };
    }

    removeInstance(name: string): void {
        this.sql.exec(`DELETE FROM instances WHERE name = ?`, name);
    }

    getInstances(filter?: InstanceFilter): InstanceRecord[] {
        let query = `SELECT * FROM instances`;
        const conditions: string[] = [];

        if (filter?.healthy !== undefined) {
            conditions.push(`healthy = ${filter.healthy ? 1 : 0}`);
        }

        if (filter?.notDraining) {
            conditions.push(`(draining IS NULL OR draining = 0)`);
        }

        if (filter?.belowCapacity !== undefined) {
            conditions.push(`active_requests < ${filter.belowCapacity}`);
        }

        if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(" AND ")}`;
        }

        query += ` ORDER BY active_requests ASC, last_heartbeat DESC`;

        return this.sql.exec<InstanceRecord>(query).toArray();
    }

    getInstanceCount(healthyOnly: boolean = true): number {
        const cursor = this.sql.exec<{ count: number }>(
            `SELECT COUNT(*) as count FROM instances ${healthyOnly ? "WHERE healthy = 1" : ""}`,
        );
        const result = cursor.toArray();
        return result[0]?.count ?? 0;
    }

    getInstanceByName(name: string): InstanceRecord | null {
        const cursor = this.sql.exec<InstanceRecord>(
            `SELECT * FROM instances WHERE name = ?`,
            name,
        );
        const result = cursor.toArray();
        return result[0] ?? null;
    }

    incrementRequests(
        name: string,
        now: string,
        healthy: boolean,
        amount: number,
    ): { previousRequests: number } {
        const healthyValue = healthy ? 1 : 0;
        const cursor = this.sql.exec<{ prev_requests: number }>(
            `INSERT INTO instances (name, created_at, active_requests, current_cpu, current_memory_MiB, current_disk_GB, last_heartbeat, last_request_at, healthy, draining, health_check_failures)
             VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, 0, 0)
             ON CONFLICT(name) DO UPDATE SET
                 active_requests = active_requests + ?,
                 last_heartbeat = ?,
                 last_request_at = ?,
                 healthy = ?,
                 current_cpu = COALESCE(current_cpu, 0),
                 current_memory_MiB = COALESCE(current_memory_MiB, 0),
                 current_disk_GB = COALESCE(current_disk_GB, 0)
             RETURNING active_requests - ? as prev_requests`,
            name,
            now,
            amount,
            now,
            now,
            healthyValue,
            amount,
            now,
            now,
            healthyValue,
            amount,
        );

        const result = cursor.toArray();
        return { previousRequests: result[0]?.prev_requests ?? 0 };
    }

    decrementRequests(name: string, now: string): void {
        this.sql.exec(
            `UPDATE instances SET
                active_requests = MAX(0, active_requests - 1),
                last_request_at = ?
             WHERE name = ?`,
            now,
            name,
        );
    }

    tryReserveSlot(): boolean {
        const cursor = this.sql.exec<{ count: number }>(
            `UPDATE instance_capacity
             SET current_count = current_count + 1
             WHERE id = 1 AND current_count < max_count
             RETURNING current_count as count`,
        );
        return cursor.toArray().length > 0;
    }

    releaseSlot(): void {
        this.sql.exec(
            `UPDATE instance_capacity
             SET current_count = MAX(0, current_count - 1)
             WHERE id = 1`,
        );
    }

    syncCapacity(): void {
        const actualCursor = this.sql.exec<{ count: number }>(
            `SELECT COUNT(*) as count FROM instances`,
        );
        const actualCount = actualCursor.toArray()[0]?.count ?? 0;

        this.sql.exec(
            `UPDATE instance_capacity SET current_count = ? WHERE id = 1`,
            actualCount,
        );
    }

    getCapacity(): CapacityInfo {
        const cursor = this.sql.exec<{
            current_count: number;
            max_count: number;
        }>(`SELECT current_count, max_count FROM instance_capacity WHERE id = 1`);
        const result = cursor.toArray()[0];

        return {
            current: result?.current_count ?? 0,
            max: result?.max_count ?? 0,
        };
    }

    getLastScaleUp(): string | null {
        const cursor = this.sql.exec<{ last_scale_up: string | null }>(
            `SELECT last_scale_up FROM scaling_state WHERE id = 1`,
        );
        const result = cursor.toArray();
        return result[0]?.last_scale_up ?? null;
    }

    getLastScaleDown(): string | null {
        const cursor = this.sql.exec<{ last_scale_down: string | null }>(
            `SELECT last_scale_down FROM scaling_state WHERE id = 1`,
        );
        const result = cursor.toArray();
        return result[0]?.last_scale_down ?? null;
    }

    getScalingState(): ScalingState {
        const cursor = this.sql.exec<{
            last_scale_up: string | null;
            last_scale_down: string | null;
        }>(`SELECT last_scale_up, last_scale_down FROM scaling_state WHERE id = 1`);
        const result = cursor.toArray()[0];

        return {
            lastScaleUp: result?.last_scale_up ?? null,
            lastScaleDown: result?.last_scale_down ?? null,
        };
    }

    recordScaleUp(now: string): void {
        this.sql.exec(
            `UPDATE scaling_state SET last_scale_up = ? WHERE id = 1`,
            now,
        );
    }

    recordScaleDown(now: string): void {
        this.sql.exec(
            `UPDATE scaling_state SET last_scale_down = ? WHERE id = 1`,
            now,
        );
    }

    updateHealth(
        name: string,
        healthy: boolean,
        failures: number,
        now: string,
    ): void {
        const healthyValue = healthy ? 1 : 0;
        this.sql.exec(
            `UPDATE instances SET
                health_check_failures = ?,
                last_health_check = ?,
                healthy = ?
             WHERE name = ?`,
            failures,
            now,
            healthyValue,
            name,
        );
    }

    getHealthCheckFailures(name: string): number {
        const cursor = this.sql.exec<{ health_check_failures: number }>(
            `SELECT health_check_failures FROM instances WHERE name = ?`,
            name,
        );
        const result = cursor.toArray();
        return result[0]?.health_check_failures ?? 0;
    }

    updateMetrics(
        name: string,
        cpu: number,
        memory: number,
        disk: number,
    ): void {
        this.sql.exec(
            `UPDATE instances SET
                current_cpu = ?,
                current_memory_MiB = ?,
                current_disk_GB = ?
             WHERE name = ?`,
            cpu,
            memory,
            disk,
            name,
        );
    }

    updateHeartbeat(name: string, now: string): void {
        this.sql.exec(
            `UPDATE instances SET
                last_heartbeat = ?,
                last_request_at = ?
             WHERE name = ?`,
            now,
            now,
            name,
        );
    }

    markDraining(name: string, now: string): void {
        this.sql.exec(
            `UPDATE instances SET
                draining = 1,
                draining_since = ?
             WHERE name = ?`,
            now,
            name,
        );
    }

    getDrainingInstances(): InstanceRecord[] {
        const cursor = this.sql.exec<InstanceRecord>(
            `SELECT name, active_requests, draining_since FROM instances WHERE draining = 1`,
        );
        return cursor.toArray();
    }

    getDrainingInfo(name: string): {
        draining: number | null;
        draining_since: string | null;
        active_requests: number;
    } | null {
        const cursor = this.sql.exec<{
            draining: number | null;
            draining_since: string | null;
            active_requests: number;
        }>(
            `SELECT draining, draining_since, active_requests FROM instances WHERE name = ?`,
            name,
        );
        const result = cursor.toArray();
        return result[0] ?? null;
    }

    migrate(maxInstances: number): void {
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS instances (
                name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                active_requests INTEGER NOT NULL,
                current_cpu REAL NOT NULL,
                current_memory_MiB INTEGER NOT NULL,
                current_disk_GB INTEGER NOT NULL,
                healthy INTEGER DEFAULT 1,
                last_heartbeat TEXT NOT NULL,
                last_request_at TEXT NOT NULL,
                draining INTEGER DEFAULT 0,
                draining_since TEXT,
                health_check_failures INTEGER DEFAULT 0,
                last_health_check TEXT
            );

            CREATE TABLE IF NOT EXISTS scaling_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_scale_up TEXT,
                last_scale_down TEXT
            );

            INSERT OR IGNORE INTO scaling_state (id, last_scale_up, last_scale_down)
            VALUES (1, NULL, NULL);

            CREATE TABLE IF NOT EXISTS instance_capacity (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                current_count INTEGER NOT NULL,
                max_count INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_instances_healthy_ordering
            ON instances(healthy, active_requests, last_heartbeat)
        `);

        const existingCount =
            this.sql
                .exec<{ count: number }>(
                    "SELECT COUNT(*) as count FROM instances",
                )
                .toArray()[0]?.count ?? 0;

        this.sql.exec(
            `INSERT OR IGNORE INTO instance_capacity (id, current_count, max_count)
             VALUES (1, ?, ?)`,
            existingCount,
            maxInstances,
        );

        this.sql.exec("DROP TABLE IF EXISTS pending_instances");
    }
}
