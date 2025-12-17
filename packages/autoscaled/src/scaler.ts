import type { AutoscalerConfig, InstanceRecord } from "./types.js";
import { AutoscalerState } from "./state.js";

export class Scaler {
    private hasSpecificThresholds: boolean;
    private hasAllSpecificThresholds: boolean;

    constructor(
        private state: AutoscalerState,
        private config: AutoscalerConfig,
    ) {
        this.hasSpecificThresholds =
            config.scaleThesholdCPU !== undefined ||
            config.scaleThesholdMemoryMiB !== undefined ||
            config.scaleThesholdDiskGB !== undefined;

        this.hasAllSpecificThresholds =
            config.scaleThesholdCPU !== undefined &&
            config.scaleThesholdMemoryMiB !== undefined &&
            config.scaleThesholdDiskGB !== undefined;

        // Warn about configuration issues
        if (
            this.hasAllSpecificThresholds &&
            config.scaleThreshold !== undefined
        ) {
            console.warn(
                "scaleThreshold will not be used when all specific thresholds are provided.",
            );
        }

        if (this.hasSpecificThresholds && !this.hasAllSpecificThresholds) {
            const missing = [];
            if (config.scaleThesholdCPU === undefined)
                missing.push("scaleThesholdCPU");
            if (config.scaleThesholdMemoryMiB === undefined)
                missing.push("scaleThesholdMemoryMiB");
            if (config.scaleThesholdDiskGB === undefined)
                missing.push("scaleThesholdDiskGB");
            console.warn(
                `Autoscaling will not respond to: ${missing.join(", ")}. Provide all three specific thresholds for complete autoscaling.`,
            );
        }
    }

    // Scale-up evaluation

    shouldScaleUpForRequests(): boolean {
        // Check if we're already at max instances
        const currentCount = this.state.getInstanceCount();
        if (currentCount >= this.config.maxInstances) {
            return false;
        }

        // Check scale-up cooldown
        if (this.isInScaleUpCooldown()) {
            return false;
        }

        // Check request-based scaling
        if (!this.config.maxRequestsPerInstance) {
            return false;
        }

        const instances = this.state.getInstances({
            healthy: true,
            notDraining: true,
        });
        const totalRequests = instances.reduce(
            (sum, inst) => sum + inst.active_requests,
            0,
        );
        const avgRequestsPerInstance =
            currentCount > 0 ? totalRequests / currentCount : 0;

        return avgRequestsPerInstance > this.config.maxRequestsPerInstance;
    }

    shouldScaleUpForMetrics(): boolean {
        // Check if we're already at max instances
        const currentCount = this.state.getInstanceCount();
        if (currentCount >= this.config.maxInstances) {
            return false;
        }

        // Check scale-up cooldown
        if (this.isInScaleUpCooldown()) {
            return false;
        }

        // Check if thresholds are configured
        if (!this.hasSpecificThresholds && !this.config.scaleThreshold) {
            return false;
        }

        const instances = this.state.getInstances({
            healthy: true,
            notDraining: true,
        });

        if (instances.length === 0) {
            return false;
        }

        const now = Date.now();
        const cooldown = this.config.scaleUpCooldown ?? 60_000;

        // Check if any instance is crossing thresholds (not already crossed recently)
        for (const instance of instances) {
            // Check if instance is eligible (hasn't crossed recently)
            const canCross =
                !instance.threshold_crossed_at ||
                now - new Date(instance.threshold_crossed_at).getTime() >=
                    cooldown;

            if (!canCross) {
                continue;
            }

            // Check if exceeds thresholds
            let exceedsThreshold = false;

            if (this.hasAllSpecificThresholds) {
                const cpuThreshold = this.config.scaleThesholdCPU ?? 0;
                const memoryThreshold = this.config.scaleThesholdMemoryMiB ?? 0;
                const diskThreshold = this.config.scaleThesholdDiskGB ?? 0;

                exceedsThreshold =
                    instance.current_cpu > cpuThreshold ||
                    instance.current_memory_MiB > memoryThreshold ||
                    instance.current_disk_GB > diskThreshold;
            } else if (this.config.scaleThreshold !== undefined) {
                const threshold = this.config.scaleThreshold;

                exceedsThreshold =
                    instance.current_cpu > threshold ||
                    instance.current_memory_MiB > threshold ||
                    instance.current_disk_GB > threshold;
            }

            if (exceedsThreshold) {
                // Mark this instance as having crossed
                this.state.markThresholdCrossed(
                    instance.name,
                    new Date(now).toISOString(),
                );
                console.info(
                    `Instance ${instance.name} crossed compute threshold (CPU: ${instance.current_cpu}%, Memory: ${instance.current_memory_MiB}%, Disk: ${instance.current_disk_GB}%)`,
                );
                return true;
            }
        }

        return false;
    }

    isInScaleUpCooldown(): boolean {
        const lastScaleUp = this.state.getLastScaleUp();
        if (!lastScaleUp) {
            return false;
        }

        const cooldown = this.config.scaleUpCooldown ?? 60_000;
        const timeSinceLastScaleUp =
            Date.now() - new Date(lastScaleUp).getTime();
        return timeSinceLastScaleUp < cooldown;
    }

    // Scale-down evaluation

    shouldScaleDown(): boolean {
        const minInstances = this.config.minInstances ?? 0;
        const currentCount = this.state.getInstanceCount();

        // Don't scale down below minimum
        if (currentCount <= minInstances) {
            return false;
        }

        // Check scale-down cooldown
        if (this.isInScaleDownCooldown()) {
            return false;
        }

        const instances = this.state.getInstances({
            healthy: true,
            notDraining: true,
        });

        if (instances.length === 0) {
            return false;
        }

        const thresholds = this.calculateScaleDownThresholds();

        // Only scale down if ALL instances are below thresholds (hysteresis)
        for (const instance of instances) {
            if (
                instance.current_cpu > thresholds.cpu ||
                instance.current_memory_MiB > thresholds.memory ||
                instance.current_disk_GB > thresholds.disk
            ) {
                return false;
            }
        }

        return true;
    }

    isInScaleDownCooldown(): boolean {
        const lastScaleDown = this.state.getLastScaleDown();
        if (!lastScaleDown) {
            return false;
        }

        const cooldown = this.config.scaleDownCooldown ?? 120_000;
        const timeSinceLastScaleDown =
            Date.now() - new Date(lastScaleDown).getTime();
        return timeSinceLastScaleDown < cooldown;
    }

    selectInstancesForRemoval(): InstanceRecord[] {
        const minInstances = this.config.minInstances ?? 0;
        const currentCount = this.state.getInstanceCount();

        let instancesToRemove: InstanceRecord[] = [];

        // First, find unhealthy instances (not already draining)
        const unhealthyInstances = this.state
            .getInstances({ healthy: false })
            .filter((inst) => !inst.draining);
        instancesToRemove.push(...unhealthyInstances);

        // If we can scale down further, find instances below thresholds
        if (currentCount - instancesToRemove.length > minInstances) {
            const thresholds = this.calculateScaleDownThresholds();

            // Get healthy, non-draining instances below thresholds
            const allInstances = this.state.getInstances({
                healthy: true,
                notDraining: true,
            });

            const belowThreshold = allInstances
                .filter(
                    (inst) =>
                        inst.current_cpu <= thresholds.cpu &&
                        inst.current_memory_MiB <= thresholds.memory &&
                        inst.current_disk_GB <= thresholds.disk,
                )
                .sort((a, b) => {
                    // Sort by active requests (fewer first), then by heartbeat (older first)
                    if (a.active_requests !== b.active_requests) {
                        return a.active_requests - b.active_requests;
                    }
                    return (
                        new Date(a.last_heartbeat).getTime() -
                        new Date(b.last_heartbeat).getTime()
                    );
                });

            const maxToRemove =
                currentCount - instancesToRemove.length - minInstances;
            instancesToRemove.push(...belowThreshold.slice(0, maxToRemove));
        }

        // Limit total removals to respect minInstances
        const maxRemovals = Math.max(0, currentCount - minInstances);
        return instancesToRemove.slice(0, maxRemovals);
    }

    // Helpers

    calculateScaleDownThresholds(): {
        cpu: number;
        memory: number;
        disk: number;
    } {
        if (this.hasAllSpecificThresholds) {
            const scaleUpCPU = this.config.scaleThesholdCPU ?? 0;
            const scaleUpMemory = this.config.scaleThesholdMemoryMiB ?? 0;
            const scaleUpDisk = this.config.scaleThesholdDiskGB ?? 0;

            return {
                cpu: this.config.scaleDownThresholdCPU ?? scaleUpCPU - 45,
                memory:
                    this.config.scaleDownThresholdMemory ?? scaleUpMemory - 45,
                disk: this.config.scaleDownThresholdDisk ?? scaleUpDisk - 45,
            };
        } else {
            const scaleUpThreshold = this.config.scaleThreshold ?? 75;
            const generalScaleDownThreshold =
                this.config.scaleDownThreshold ?? scaleUpThreshold - 45;

            return {
                cpu: generalScaleDownThreshold,
                memory: generalScaleDownThreshold,
                disk: generalScaleDownThreshold,
            };
        }
    }

    metricsExceedThresholds(
        instance: InstanceRecord,
        thresholds: { cpu: number; memory: number; disk: number },
    ): boolean {
        return (
            instance.current_cpu > thresholds.cpu ||
            instance.current_memory_MiB > thresholds.memory ||
            instance.current_disk_GB > thresholds.disk
        );
    }
}
