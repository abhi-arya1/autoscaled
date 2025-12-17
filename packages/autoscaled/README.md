# AutoscaleD

Automatically scale Cloudflare Containers based on compute, load, status, and more, for distributed applications on Cloudflare's edge network.

## Installation

> [!WARNING] This package is not yet released.
> This banner will be removed once the package is published to npm.

```shell
npm install @abhi-arya1/autoscaled
```

## Why Use AutoscaleD?

**AutoscaleD** provides an automatic load balancing service that sits in front of any Cloudflare Container and automatically controls the number of running containers based on actual demand. It can scale to 0, ensuring you have no unused compute after a point, while intelligently scaling up when needed to minimize latency for users worldwide.

## Usage

Here's an example of how to use AutoscaleD:

Write your code:

```ts
// Define your Container
export class MyContainer extends Container<Env> {
    // Port the container listens on (default: 8080)
    defaultPort = 8080;

    // Port 81 for monitor (see Monitoring section below)
    requiredPorts = [8080, 81];

    // Set this to anything greater than heartbeatInterval, since this will no longer be used, and the Autoscaler will manage sleep/wakeup.
    sleepAfter = "2m";
    envVars = {
        MESSAGE: "I was passed in via the container class!",
    };
}

// Import and Define your Autoscaler

import { Autoscaler, routeContainerRequest } from "@abhi-arya1/autoscaled";

export class MyAutoscaler extends Autoscaler<Env> {
    config = {
        // See Instance Types for available options
        // https://developers.cloudflare.com/containers/platform-details/limits/
        instance: "standard-1",
        maxInstances: 5,
        minInstances: 1,
    };

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env, env.MY_CONTAINER);
    }
}

export default {
    // Set up your fetch handler to use configured server
    // `env.AUTOSCALER` is the Wrangler binding to your Autoscaler class, such as MyAutoscaler above
    async fetch(request: Request, env: Env): Promise<Response> {
        return (
            (await routeContainerRequest(request, env.AUTOSCALER)) ||
            new Response("Not Found", { status: 404 })
        );
    },
} satisfies ExportedHandler<Env>;
```

And configure your `wrangler.toml`:

```toml
name = "my-worker"
main = "index.ts"

[[durable_objects.bindings]]
name = "MyAutoscaler"
class_name = "MyAutoscaler"

[[migrations]]
tag = "v1" # Should be unique for each entry
new_classes = ["MyAutoscaler"]
```

Any request to your worker will now be routed to the least loaded container through the autoscaler, with minimal latency impact.

## Customizing `Autoscaler`

`Autoscaler` is a class that extends `DurableObject`. You can override any of the `DurableObject` methods on `Autoscaler` to add custom behavior.

You can override the `config` property to customize the autoscaler's behavior.

```ts
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
```

## Monitoring Containers

You might've seen the `monitorzURL` option in the config, or the fact that port 81 is required in the container class.

Since Cloudflare Containers are still in beta, and do not have a dedicated metrics endpoint (that I could find), the [monitor](../monitor/) package implements a lightweight HTTP server in Go that can be used to monitor resources for scaling.

> [!NOTE] Platform Targets
> The monitor is by default built for `GOOS=linux GOARCH=amd64` in this package. Feel free to rebuild it for your own platform.

In your Container `Dockerfile`, you can copy the monitor and then

```dockerfile
COPY monitor /monitor

EXPOSE 81 # Add your ports to this list

# Use monitor in exec mode: monitor runs on port 81 and execs the server
CMD ["/monitor", ...] # your executable goes here
```

The full documentation for the monitor is available [here](../monitor/README.md).

Note that the configuration option is offered if you do not want to use the provided monitor, and instead your own endpoint. You can set the `monitorzURL` option to your own path in the container. This has to be of the form `GET http://<your-endpoint>/<your-path>`.

It must return a JSON object with the following fields for usage in the Autoscaler.

```ts
export type MonitorzData = {
    // Percentages on a 0-100 scale
    cpu_usage: number;
    memory_usage: number;
    disk_usage: number;
};
```

# How does it work?

AutoscaleD is built as a Cloudflare Durable Object that acts as an intelligent load balancer and autoscaler for Cloudflare Containers. It maintains state about all running container instances and makes scaling decisions based on metrics, request load, and health status.

> I was a little lazy with this write-up so everything below this point has been helped in some part by Claude Code.

## Architecture

The Autoscaler consists of four core components that work together:

- **`AutoscalerState`**: Manages persistent state in SQL (Durable Object storage) tracking all instances, their metrics, health status, and capacity limits
- **`Router`**: Selects the best instance for each incoming request based on load balancing criteria
- **`Scaler`**: Evaluates when to scale up or down based on configured thresholds and metrics
- **`InstanceManager`**: Handles the container lifecycle (creation, destruction, health checks, metrics collection)

## Request Flow

When a request arrives at your worker:

1. **Routing**: The `Router` selects the least-loaded healthy instance that isn't draining and has capacity available (compute and request based)
2. **Health Check**: If the selected instance is unhealthy, the Autoscaler attempts to create a replacement instance or route to another healthy instance
3. **Request Execution**: The request is forwarded to the selected container instance
4. **Load Tracking**: Active request counts are incremented before the request and decremented after completion
5. **Optimistic Scale-Up**: If an instance crosses its capacity thresholds, a new instance is created proactively in the background to prevent overload

## Periodic Heartbeat (Alarm Handler)

The Autoscaler runs a periodic heartbeat (default: every 30 seconds) that performs several maintenance tasks:

1. **Cleanup**: Removes stale instances that no longer exist in the container namespace
2. **Metrics Collection**: Fetches CPU, memory, and disk usage from each instance's monitoring endpoint (`/monitorz`)
3. **Health Checks**: Performs health checks on all instances and marks them unhealthy after consecutive failures
4. **Scale-Up Evaluation**: Checks if any instance is crossing CPU/memory/disk thresholds (transitioning from below to above) and creates new instances if needed
5. **Scale-Down Evaluation**: Checks if all instances are below scale-down thresholds and initiates draining for excess instances
6. **Drain Processing**: Monitors draining instances and removes them once they have no active requests or the drain timeout expires

## Scaling Mechanisms

### Scale-Up Triggers

The Autoscaler can scale up based on two mechanisms:

1. **Metrics-Based Scaling**: When any instance crosses configured CPU, memory, or disk thresholds (via `scaleThreshold` or specific thresholds like `scaleThesholdCPU`)
    - Uses "just crossed" detection to prevent duplicate scale-ups
    - Tracks each instance's `threshold_crossed_at` timestamp
    - Only triggers scale-up if the instance hasn't crossed within the cooldown period (60s)
    - Prevents duplicate instance placements from the same threshold breach

2. **Request-Based Scaling**: When the average requests per instance exceeds `maxRequestsPerInstance` (if configured)
    - Uses optimistic scaling with `scaleUpCapacityThreshold` (default: 70%)
    - Scales proactively before hitting maximum capacity to prevent overload

Scale-ups respect:

- `maxInstances` limit
- `scaleUpCooldown` period (default: 60 seconds) to prevent rapid scaling

### Scale-Down Process

Scale-down uses a hysteresis pattern to prevent flapping:

1. **Evaluation**: Only scales down when ALL healthy instances are below the scale-down thresholds (typically 45% below scale-up thresholds)
2. **Selection**: Chooses instances with the fewest active requests and oldest heartbeat times
3. **Draining**: Marks selected instances as "draining" and stops routing new requests to them
4. **Removal**: Waits for active requests to complete (up to `drainTimeout`, default: 60 seconds) before destroying the instance

Scale-downs respect:

- `minInstances` limit
- `scaleDownCooldown` period (default: 120 seconds)

## Instance Lifecycle

### Creation

When a new instance is needed:

1. A slot is reserved in the capacity tracking system (prevents exceeding `maxInstances`)
2. A new container is created with a unique name (using `nanoid`)
3. The container is started and waits for ports to be ready
4. The instance is registered in the state database with initial metrics
5. Health check is performed to verify the instance is ready

### Health Monitoring

Each instance is continuously monitored:

- **Health Checks**: Performed periodically via the `monitoringEndpoint` (default: `/healthz`)
- **Failure Tracking**: Instances are marked unhealthy after `healthCheckRetries` consecutive failures (default: 3)
- **Metrics Collection**: CPU, memory, and disk usage are fetched from the `monitorzURL` endpoint
- **Keep-Alive**: Healthy instances receive periodic keep-alive requests to prevent sleep

### Removal

Instances are removed when:

1. They become stale (no longer exist in the container namespace)
2. They're selected for scale-down and successfully drain
3. They're replaced due to being unhealthy
4. They exceed the drain timeout while draining

## State Management

The Autoscaler uses SQL (via Durable Object storage) to maintain:

- **Instance Records**: Name, creation time, active request count, current metrics (CPU/memory/disk), health status, draining status, and threshold crossing timestamps
- **Capacity Tracking**: Current and maximum instance counts (prevents race conditions)
- **Scaling State**: Timestamps of last scale-up and scale-down (for cooldown enforcement)
- **Threshold Tracking**: Per-instance `threshold_crossed_at` timestamps to prevent duplicate scale-ups from compute metrics

This persistent state ensures the Autoscaler can recover from restarts and maintain consistency across concurrent operations.

## Initialization

When the Autoscaler Durable Object is first created or restarted:

1. **Database Migration**: Creates necessary tables if they don't exist
2. **Stale Cleanup**: Removes any instances from the database that no longer exist
3. **Capacity Sync**: Synchronizes the capacity counter with actual instance count
4. **Warm-Up**: Creates `minInstances` containers to ensure minimum capacity is available
5. **Alarm Scheduling**: Schedules the first heartbeat alarm

This ensures the Autoscaler starts in a consistent state and maintains the configured minimum instances.

# Limitations

This autoscaler is still not a native solution, just a wrapper around functionality that Cloudflare already provides. I know that one is slated on the roadmap, but I wanted to give a shot at making one a reality anyways.

Thanks for reading and let me know what you think!
