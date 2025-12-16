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
  // Time before container sleeps due to inactivity (default: 30s)
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
    // The binding to your container class from wrangler.jsonc/toml
    containerBinding: this.env.MY_CONTAINER as any,
  };
}

export default {
  // Set up your fetch handler to use configured Servers
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeContainerRequest(request, env)) ||
      new Response("Not Found", { status: 404 })
    );
  }
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
    // The instance type, to account for compute constraints of a container
    instance: InstanceType;
    // The required Workers Binding to your container class from wrangler.jsonc/toml
    containerBinding: DurableObjectNamespace<Container<unknown>>;
    // The maximum number of containers to run
    maxInstances: number;
    // The minimum number of containers to run
    minInstances?: number;
    // The maximum number of requests that a container can handle at once before it is considered overloaded
    maxRequestsPerInstance?: number;
    // More options to come...
}
```

## Things to Add

> [!NOTE] AutoscaleD is still in development.
> Here are some features to wrap up.

- Container compute monitoring for balancing
- More options for scaling, based on specific metrics or thresholds 
- More container startup options
