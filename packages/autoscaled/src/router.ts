import type { AutoscalerConfig, InstanceRecord } from "./types.js";
import { AutoscalerState } from "./state.js";

export class Router {
    constructor(
        private state: AutoscalerState,
        private config: AutoscalerConfig,
    ) {}

    selectInstance(): InstanceRecord | null {
        const maxRequestsPerInstance = this.config.maxRequestsPerInstance;

        const instances = this.state.getInstances({
            healthy: true,
            notDraining: true,
            belowCapacity: maxRequestsPerInstance,
        });

        if (instances.length > 0) {
            return instances[0] ?? null;
        }

        const anyHealthy = this.state.getInstances({
            healthy: true,
            notDraining: true,
        });

        if (anyHealthy.length > 0) {
            return anyHealthy[0] ?? null;
        }

        return null;
    }

    shouldCreateInstance(
        healthyCount: number,
        atCapacityCount: number,
    ): boolean {
        const maxRequestsPerInstance = this.config.maxRequestsPerInstance;

        if (maxRequestsPerInstance === undefined) {
            return false;
        }

        return atCapacityCount === healthyCount && healthyCount > 0;
    }

    checkOptimisticScaleUp(
        instanceName: string,
        previousActiveRequests: number,
    ): boolean {
        if (!this.config.maxRequestsPerInstance) {
            return false;
        }

        const threshold = this.config.scaleUpCapacityThreshold ?? 0.7;
        const capacityLimit = Math.floor(
            this.config.maxRequestsPerInstance * threshold,
        );

        const currentRequests = previousActiveRequests + 1;

        const justCrossed =
            previousActiveRequests < capacityLimit &&
            currentRequests >= capacityLimit;

        if (justCrossed) {
            console.info(
                `Instance ${instanceName} crossed threshold: ${previousActiveRequests}→${currentRequests} (threshold: ${capacityLimit})`,
            );
        }

        return justCrossed;
    }

    getAtCapacityCount(): number {
        const maxRequestsPerInstance = this.config.maxRequestsPerInstance;

        if (maxRequestsPerInstance === undefined) {
            return 0;
        }

        const instances = this.state.getInstances({
            healthy: true,
            notDraining: true,
        });

        return instances.filter(
            (inst) => inst.active_requests >= maxRequestsPerInstance,
        ).length;
    }
}
