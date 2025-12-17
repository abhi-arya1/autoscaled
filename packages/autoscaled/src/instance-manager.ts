import {
    getContainer as getContainerInstance,
    type State,
} from "@cloudflare/containers";
import { nanoid } from "nanoid";
import type {
    ContainerStub,
    ContainerNamespace,
    ContainerWithState,
    AutoscalerConfig,
    InstanceRecord,
    MonitorzData,
} from "./types.js";
import { AutoscalerState } from "./state.js";

export class InstanceManager<Env = unknown> {
    constructor(
        private state: AutoscalerState,
        private container: ContainerNamespace<Env>,
        private config: AutoscalerConfig,
        private getNow: () => string,
    ) {}

    async createInstance(): Promise<ContainerStub<Env>> {
        const container = getContainerInstance(this.container, nanoid());
        await container.startAndWaitForPorts();
        console.info(`Created instance ${this.getContainerName(container)}`);
        return container;
    }

    async destroyInstance(name: string): Promise<void> {
        try {
            const container = this.container.getByName(name);
            await container.destroy();
            this.state.removeInstance(name);
        } catch (error) {
            console.error(`Error destroying instance ${name}:`, error);
            this.state.removeInstance(name);
        }
    }

    async replaceInstance(
        container: ContainerStub<Env>,
    ): Promise<ContainerWithState<Env>> {
        const name = this.getContainerName(container);
        await this.destroyInstance(name);

        const newContainer = await this.createInstance();
        await newContainer.startAndWaitForPorts();

        return {
            container: newContainer,
            state: await newContainer.getState(),
        };
    }

    async performHealthCheck(
        container: ContainerStub<Env>,
        instanceName: string,
    ): Promise<boolean> {
        const healthEndpoint = this.config.monitoringEndpoint ?? "/healthz";
        const healthUrl = healthEndpoint.startsWith("http")
            ? healthEndpoint
            : `http://localhost:8080${healthEndpoint}`;
        const now = this.getNow();

        try {
            const response = await container.containerFetch(healthUrl);
            const isHealthy = response.ok;

            if (isHealthy) {
                this.state.updateHealth(instanceName, true, 0, now);
                return true;
            } else {
                const currentFailures =
                    this.state.getHealthCheckFailures(instanceName);
                const newFailures = currentFailures + 1;
                const healthCheckRetries = this.config.healthCheckRetries ?? 3;

                this.state.updateHealth(
                    instanceName,
                    newFailures < healthCheckRetries,
                    newFailures,
                    now,
                );
                return false;
            }
        } catch (error) {
            const currentFailures =
                this.state.getHealthCheckFailures(instanceName);
            const newFailures = currentFailures + 1;
            const healthCheckRetries = this.config.healthCheckRetries ?? 3;

            this.state.updateHealth(
                instanceName,
                newFailures < healthCheckRetries,
                newFailures,
                now,
            );
            return false;
        }
    }

    async fetchMonitorz(container: ContainerStub<Env>): Promise<MonitorzData> {
        const url = this.config.monitorzURL ?? "http://localhost:81/monitorz";
        const response = await container.containerFetch(url);

        if (!response.ok) {
            throw new Error(
                `Failed to fetch monitorz data: ${response.status}`,
            );
        }

        return (await response.json()) as MonitorzData;
    }

    async keepAlive(instances: InstanceRecord[]): Promise<void> {
        if (instances.length === 0) {
            return;
        }

        const keepAliveEndpoint = this.config.monitoringEndpoint ?? "/healthz";
        const keepAliveUrl = keepAliveEndpoint.startsWith("http")
            ? keepAliveEndpoint
            : `http://container/${keepAliveEndpoint}`;
        const now = this.getNow();

        for (const instance of instances) {
            try {
                const container = this.container.getByName(instance.name);
                await container.fetch(keepAliveUrl);

                this.state.updateHeartbeat(instance.name, now);
            } catch (error) {
                console.error(
                    `Error keeping instance ${instance.name} alive:`,
                    error,
                );
            }
        }
    }

    async getContainerByName(
        name: string,
    ): Promise<ContainerWithState<Env> | null> {
        try {
            const container = this.container.getByName(name);
            const state = await container.getState();
            return { container, state };
        } catch {
            console.warn(`Instance ${name} not found, removing from database`);
            this.state.removeInstance(name);
            return null;
        }
    }

    getContainerName(container: ContainerStub<Env>): string {
        return container.name || container.id.toString();
    }

    isHealthy(state: State): boolean {
        return state.status === "running" || state.status === "healthy";
    }

    async cleanupStaleInstances(): Promise<string[]> {
        const instances = this.state.getInstances();

        if (instances.length === 0) {
            return [];
        }

        const cleaned: string[] = [];

        for (const instance of instances) {
            if (!instance.name) continue;

            try {
                const container = this.container.getByName(instance.name);
                await container.getState(); // This will throw if container doesn't exist
            } catch {
                console.warn(
                    `Removing stale instance ${instance.name} from database`,
                );
                this.state.removeInstance(instance.name);
                cleaned.push(instance.name);
            }
        }

        if (cleaned.length > 0) {
            console.info(`Cleaned up ${cleaned.length} stale instance(s)`);
        }

        return cleaned;
    }
}
