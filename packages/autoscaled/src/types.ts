import type { Container, State } from "@cloudflare/containers";

export type GenericContainer<T = unknown> = Container<T>;
export type ContainerStub<T = unknown> = DurableObjectStub<GenericContainer<T>>;
export type ContainerNamespace<T = unknown> = DurableObjectNamespace<
    GenericContainer<T>
>;

export interface InstanceRecord extends Record<string, string | number | null> {
    name: string;
    created_at: string; // ISO 8601
    active_requests: number;
    current_cpu: number; // vCPU
    current_memory_MiB: number; // MB
    current_disk_GB: number; // GB
    healthy: 0 | 1;
    last_heartbeat: string; // ISO 8601
    last_request_at: string; // ISO 8601
    draining: 0 | 1 | null;
    draining_since: string | null; // ISO 8601
    health_check_failures: number;
    last_health_check: string | null; // ISO 8601
    threshold_crossed_at: string | null; // ISO 8601
}

export type MonitorzData = {
    // Percentages on a 0-100 scale
    cpu_usage: number;
    memory_usage: number;
    disk_usage: number;
};

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
     * The capacity threshold (0-1) at which to trigger optimistic scale-up
     * For example, 0.7 means scale up when instances reach 70% of maxRequestsPerInstance
     * This prevents race conditions by scaling up before hitting capacity
     * @default 0.7
     */
    scaleUpCapacityThreshold?: number;
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
     * Milliseconds to wait after scale-up before scaling again
     * @default 60_000 (1 minute)
     */
    scaleUpCooldown?: number;
    /**
     * Milliseconds to wait after scale-down before scaling again
     * @default 120_000 (2 minutes)
     */
    scaleDownCooldown?: number;
    /**
     * General threshold for scaling down (defaults to scaleThreshold - 45% for hysteresis)
     */
    scaleDownThreshold?: number;
    /**
     * CPU percentage threshold for scaling down
     */
    scaleDownThresholdCPU?: number;
    /**
     * Memory usage percentage threshold for scaling down
     */
    scaleDownThresholdMemory?: number;
    /**
     * Disk usage percentage threshold for scaling down
     */
    scaleDownThresholdDisk?: number;
    /**
     * Number of consecutive health check failures before marking unhealthy
     * @default 3
     */
    healthCheckRetries?: number;
    /**
     * Maximum time to wait for instance draining (milliseconds)
     * @default 60_000 (1 minute)
     */
    drainTimeout?: number;
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

export interface InstanceFilter {
    healthy?: boolean;
    notDraining?: boolean;
    belowCapacity?: number;
}

export interface CapacityInfo {
    current: number;
    max: number;
}

export interface ScalingState {
    lastScaleUp: string | null;
    lastScaleDown: string | null;
}

export interface ContainerWithState<T = unknown> {
    container: ContainerStub<T>;
    state: State;
}
