import { DurableObject } from "cloudflare:workers";
import type { State } from "@cloudflare/containers";

import type {
    GenericContainer,
    ContainerStub,
    ContainerNamespace,
    InstanceRecord,
    MonitorzData,
    InstanceType,
    Instance,
    AutoscalerConfig,
} from "./types.js";

import { AutoscalerState } from "./state.js";
import { Scaler } from "./scaler.js";
import { Router } from "./router.js";
import { InstanceManager } from "./instance-manager.js";

export type {
    GenericContainer,
    ContainerStub,
    ContainerNamespace,
    InstanceRecord,
    MonitorzData,
    InstanceType,
    Instance,
    AutoscalerConfig,
};

export { INSTANCE_SPECS } from "./types.js";

const AUTOSCALER_STUB_NAME = "main";

export const routeContainerRequest = async (
    request: Request,
    binding: any,
): Promise<Response> => {
    try {
        const autoscalerId = binding.idFromName(AUTOSCALER_STUB_NAME);
        const instance = binding.get(autoscalerId);

        return (await instance.fetch(request)) as Response;
    } catch (error: unknown) {
        console.error(error);
        return new Response("Internal Server Error", { status: 500 });
    }
};

export class Autoscaler<Env> extends DurableObject<Env> {
    container: ContainerNamespace<Env>;
    config: AutoscalerConfig = {
        instance: "standard-1",
        maxInstances: 10,
        minInstances: 1,
        heartbeatInterval: 30_000,
        staleThreshold: 120_000,
        monitoringEndpoint: "/healthz",
        scaleThreshold: 75,
        scaleUpCapacityThreshold: 0.7,
        monitorzURL: "http://localhost:81/monitorz",
        scaleUpCooldown: 60_000,
        scaleDownCooldown: 120_000,
        healthCheckRetries: 3,
        drainTimeout: 60_000,
    };

    private state!: AutoscalerState;
    private scaler!: Scaler;
    private router!: Router;
    private instanceManager!: InstanceManager<Env>;

    #getISO8601Now(): string {
        return new Date().toISOString();
    }

    constructor(ctx: DurableObjectState, env: Env, container: any) {
        super(ctx, env);

        this.container = container;

        this.state = new AutoscalerState(ctx.storage.sql, () =>
            this.#getISO8601Now(),
        );
        this.scaler = new Scaler(this.state, this.config);
        this.router = new Router(this.state, this.config);
        this.instanceManager = new InstanceManager<Env>(
            this.state,
            this.container,
            this.config,
            () => this.#getISO8601Now(),
        );

        ctx.blockConcurrencyWhile(async () => {
            this.state.migrate(this.config.maxInstances);
            const cleaned = await this.instanceManager.cleanupStaleInstances();
            if (cleaned.length > 0) {
                this.state.syncCapacity();
            }
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
        // 1. Cleanup stale instances
        const cleaned = await this.instanceManager.cleanupStaleInstances();
        if (cleaned.length > 0) {
            this.state.syncCapacity();
        }

        // 2. Keep instances alive
        const instances = this.state.getInstances({
            healthy: true,
            notDraining: true,
        });
        await this.instanceManager.keepAlive(instances);

        // 3. Update metrics (includes health checks)
        await this.#updateAllInstanceMetrics();

        // 4. Evaluate scale-up based on metrics
        if (this.scaler.shouldScaleUpForMetrics()) {
            await this.#scaleUp();
        }

        // 5. Evaluate scale-down
        if (this.scaler.shouldScaleDown()) {
            await this.#scaleDown();
        }

        // 6. Process draining instances
        await this.#processDrainingInstances();

        // 7. Schedule next alarm
        await this.scheduleAlarm();
    }

    private async warmUpInstances(): Promise<void> {
        const minInstances = this.config.minInstances ?? 0;
        for (let i = 0; i < minInstances; i++) {
            const reserved = this.state.tryReserveSlot();
            if (!reserved) {
                console.warn(
                    `Could not warm up ${minInstances} instances, max capacity reached at ${i}`,
                );
                break;
            }

            try {
                const container = await this.instanceManager.createInstance();
                this.ctx.waitUntil(container.startAndWaitForPorts());
                const state = await container.getState();
                await this.#trackNewInstance(container, state, 0);
            } catch (error) {
                console.error("Error warming up instance:", error);
                this.state.releaseSlot();
            }
        }
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // Health check endpoint
        if (
            url.pathname === this.config.monitoringEndpoint &&
            request.method === "GET"
        ) {
            return await this.#getHealthz();
        }

        try {
            const instance = this.router.selectInstance();

            if (!instance) {
                return await this.#handleNoInstanceAvailable();
            }

            const containerResult =
                await this.instanceManager.getContainerByName(instance.name);
            if (!containerResult) {
                return await this.#retryRequestAfterCleanup(request);
            }

            const { container, state } = containerResult;

            if (!this.instanceManager.isHealthy(state)) {
                return await this.#handleUnhealthyInstance(request, container);
            }

            const { previousRequests } = this.state.incrementRequests(
                instance.name,
                this.#getISO8601Now(),
                instance.healthy === 1,
                1,
            );

            if (
                this.router.checkOptimisticScaleUp(
                    instance.name,
                    previousRequests,
                )
            ) {
                this.ctx.waitUntil(this.#handleOptimisticScaleUp());
            }

            return await this.#executeRequest(request, container);
        } catch (error) {
            console.error("Error routing request:", error);
            return new Response("Internal Server Error", { status: 500 });
        }
    }

    async #getHealthz(): Promise<Response> {
        const instanceCount = this.state.getInstanceCount();
        const instances = this.state.getInstances();

        return new Response(
            JSON.stringify({
                instanceCount,
                instances,
            }),
            { status: 200 },
        );
    }

    async #handleNoInstanceAvailable(): Promise<Response> {
        if (this.state.tryReserveSlot()) {
            try {
                await this.instanceManager.cleanupStaleInstances();
                const container = await this.instanceManager.createInstance();
                const state = await container.getState();
                await this.#trackNewInstance(container, state, 0);
                return new Response("Service is starting up, please retry", {
                    status: 503,
                    headers: { "Retry-After": "5" },
                });
            } catch (error) {
                console.error("Failed to create new instance:", error);
                this.state.releaseSlot();
            }
        }

        return new Response("Service Unavailable", { status: 503 });
    }

    async #retryRequestAfterCleanup(request: Request): Promise<Response> {
        await this.instanceManager.cleanupStaleInstances();
        const instance = this.router.selectInstance();

        if (instance) {
            const containerResult =
                await this.instanceManager.getContainerByName(instance.name);
            if (containerResult) {
                const { container } = containerResult;
                this.state.incrementRequests(
                    instance.name,
                    this.#getISO8601Now(),
                    instance.healthy === 1,
                    1,
                );
                return await this.#executeRequest(request, container);
            }
        }

        return new Response("Service Unavailable", { status: 503 });
    }

    async #handleUnhealthyInstance(
        request: Request,
        container: ContainerStub<Env>,
    ): Promise<Response> {
        if (this.state.tryReserveSlot()) {
            try {
                await this.instanceManager.cleanupStaleInstances();
                const newContainer =
                    await this.instanceManager.createInstance();
                const newState = await newContainer.getState();
                await this.#trackNewInstance(newContainer, newState, 0);

                // Use the new instance for this request
                const newInstanceName =
                    this.instanceManager.getContainerName(newContainer);
                this.state.incrementRequests(
                    newInstanceName,
                    this.#getISO8601Now(),
                    true,
                    1,
                );
                return await this.#executeRequest(request, newContainer);
            } catch (error) {
                console.warn(
                    "Failed to create new instance, releasing reservation:",
                    error,
                );
                this.state.releaseSlot();
            }
        }

        console.info("Replacing unhealthy instance");
        const replaced = await this.instanceManager.replaceInstance(container);
        return await this.#executeRequest(request, replaced.container);
    }

    async #executeRequest(
        request: Request,
        container: ContainerStub<Env>,
    ): Promise<Response> {
        const containerName = this.instanceManager.getContainerName(container);

        try {
            const response = await container.fetch(request);

            this.ctx.waitUntil(
                this.#afterRequest(containerName).catch((err) => {
                    console.error("Error after request:", err);
                }),
            );

            return response;
        } catch (error) {
            this.ctx.waitUntil(
                this.#afterRequest(containerName).catch((err) => {
                    console.error("Error after request:", err);
                }),
            );
            throw error;
        }
    }

    async #afterRequest(containerName: string): Promise<void> {
        this.state.decrementRequests(containerName, this.#getISO8601Now());
    }

    async #trackNewInstance(
        container: ContainerStub<Env>,
        state: State,
        initialRequests: number,
    ): Promise<void> {
        const containerName = this.instanceManager.getContainerName(container);
        const healthy = this.instanceManager.isHealthy(state);
        this.state.recordInstance(
            containerName,
            initialRequests,
            healthy,
            this.#getISO8601Now(),
        );
    }

    async #handleOptimisticScaleUp(): Promise<void> {
        const reserved = this.state.tryReserveSlot();
        if (!reserved) {
            console.warn("Max instances reached, skipping scale-up");
            return;
        }

        try {
            const container = await this.instanceManager.createInstance();
            const state = await container.getState();
            await this.#trackNewInstance(container, state, 0);
            this.state.recordScaleUp(this.#getISO8601Now());
            console.info(
                `Created new instance ${this.instanceManager.getContainerName(container)} due to threshold crossing`,
            );
        } catch (error) {
            console.error("Error during scale-up:", error);
            this.state.releaseSlot();
        }
    }

    async #scaleUp(): Promise<void> {
        const reserved = this.state.tryReserveSlot();
        if (!reserved) {
            console.warn("Max instances reached, skipping threshold scale-up");
            return;
        }

        try {
            const container = await this.instanceManager.createInstance();
            const state = await container.getState();
            await this.#trackNewInstance(container, state, 0);
            this.state.recordScaleUp(this.#getISO8601Now());
            console.info(
                `Created new instance ${this.instanceManager.getContainerName(container)}`,
            );
        } catch (error) {
            console.error("Error scaling up:", error);
            this.state.releaseSlot();
        }
    }

    async #scaleDown(): Promise<void> {
        const instancesToRemove = this.scaler.selectInstancesForRemoval();

        let scaledDown = false;
        for (const instance of instancesToRemove) {
            if (!instance.name) continue;

            try {
                await this.#drainInstance(instance.name);
                scaledDown = true;
            } catch (error) {
                console.error(
                    `Error draining instance ${instance.name}:`,
                    error,
                );
            }
        }

        if (scaledDown) {
            this.state.recordScaleDown(this.#getISO8601Now());
        }
    }

    async #updateAllInstanceMetrics(): Promise<void> {
        const instances = this.state.getInstances();

        if (instances.length === 0) {
            return;
        }

        for (const instance of instances) {
            try {
                const container = this.container.getByName(instance.name);

                await this.instanceManager.performHealthCheck(
                    container,
                    instance.name,
                );

                const instanceRecord = this.state.getInstanceByName(
                    instance.name,
                );

                if (instanceRecord?.healthy === 1) {
                    try {
                        const monitorzData =
                            await this.instanceManager.fetchMonitorz(container);

                        const cpu = monitorzData.cpu_usage ?? 0;
                        const memory = monitorzData.memory_usage ?? 0;
                        const disk = monitorzData.disk_usage ?? 0;

                        this.state.updateMetrics(
                            instance.name,
                            cpu,
                            memory,
                            disk,
                        );
                    } catch (metricsError) {
                        console.error(
                            `Error fetching metrics for instance ${instance.name}:`,
                            metricsError,
                        );
                    }
                }
            } catch (error) {
                console.error(
                    `Error updating metrics for instance ${instance.name}:`,
                    error,
                );
            }
        }
    }

    async #processDrainingInstances(): Promise<void> {
        const drainingInstances = this.state.getDrainingInstances();

        for (const instance of drainingInstances) {
            if (!instance.name) continue;

            const drainTimeout = this.config.drainTimeout ?? 60_000;
            const timeSinceDraining = instance.draining_since
                ? Date.now() - new Date(instance.draining_since).getTime()
                : Infinity;

            if (
                instance.active_requests === 0 ||
                timeSinceDraining >= drainTimeout
            ) {
                await this.#drainInstance(instance.name);
            }
        }
    }

    async #drainInstance(instanceName: string): Promise<void> {
        const drainingInfo = this.state.getDrainingInfo(instanceName);

        if (!drainingInfo) {
            return;
        }

        if (!drainingInfo.draining) {
            this.state.markDraining(instanceName, this.#getISO8601Now());
            return;
        }

        if (drainingInfo.active_requests === 0) {
            try {
                await this.instanceManager.destroyInstance(instanceName);
                return;
            } catch (error) {
                console.error(
                    `Error removing drained instance ${instanceName}:`,
                    error,
                );
                return;
            }
        }

        if (drainingInfo.draining_since) {
            const drainTimeout = this.config.drainTimeout ?? 60_000;
            const timeSinceDraining =
                Date.now() - new Date(drainingInfo.draining_since).getTime();

            if (timeSinceDraining >= drainTimeout) {
                console.warn(
                    `Instance ${instanceName} did not drain within timeout (${drainingInfo.active_requests} active requests remaining). Proceeding with removal.`,
                );
                try {
                    await this.instanceManager.destroyInstance(instanceName);
                } catch (error) {
                    console.error(
                        `Error removing timed-out instance ${instanceName}:`,
                        error,
                    );
                }
            }
        }
    }
}
