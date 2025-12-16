import { Container, getContainer, getRandom } from "@cloudflare/containers";
import { Hono } from "hono";
import { Autoscaler } from "autoscaled";

export class MyContainer extends Container<Env> {
  // Port the container listens on (default: 8080)
  defaultPort = 8080;
  // Time before container sleeps due to inactivity (default: 30s)
  sleepAfter = "2m";
  // Environment variables passed to the container
  envVars = {
    MESSAGE: "I was passed in via the container class!",
  };

  // Optional lifecycle hooks
  override onStart() {
    console.log("Container successfully started");
  }

  override onStop() {
    console.log("Container successfully shut down");
  }

  override onError(error: unknown) {
    console.log("Container error:", error);
  }
}

// Autoscaler that manages MyContainer instances
export class MyAutoscaler extends Autoscaler<Env> {
  config = {
    instance: "standard-1" as const,
    maxInstances: 5,
    minInstances: 1,
    containerBinding: this.env.MY_CONTAINER as any,
  };
}

// Create Hono app with proper typing for Cloudflare Workers
const app = new Hono<{
  Bindings: Env;
}>();

// Home route with available endpoints
app.get("/", (c) => {
  return c.text(
    "Available endpoints:\n" +
      "GET /container/<ID> - Start a container for each ID with a 2m timeout\n" +
      "GET /lb - Load balance requests over multiple containers\n" +
      "GET /error - Start a container that errors (demonstrates error handling)\n" +
      "GET /singleton - Get a single specific container instance\n" +
      "GET /autoscaler/* - Route requests through autoscaler (load balances and auto-scales)",
  );
});

// Route requests to a specific container using the container ID
app.get("/container/:id", async (c) => {
  const id = c.req.param("id");
  const containerId = c.env.MY_CONTAINER.idFromName(`/container/${id}`);
  const container = c.env.MY_CONTAINER.get(containerId);
  return await container.fetch(c.req.raw);
});

// Demonstrate error handling - this route forces a panic in the container
app.get("/error", async (c) => {
  const container = getContainer(c.env.MY_CONTAINER, "error-test");
  return await container.fetch(c.req.raw);
});

// Load balance requests across multiple containers
app.get("/lb", async (c) => {
  const container = await getRandom(c.env.MY_CONTAINER, 3);
  return await container.fetch(c.req.raw);
});

// Get a single container instance (singleton pattern)
app.get("/singleton", async (c) => {
  const container = getContainer(c.env.MY_CONTAINER);
  return await container.fetch(c.req.raw);
});

// Autoscaler route - routes all requests through the autoscaler
app.all("/autoscaler/*", async (c) => {
  // Get the autoscaler DO instance (singleton pattern)
  // Note: AUTOSCALER should be defined in wrangler.jsonc as a Durable Object binding
  const autoscalerBinding = c.env.AUTOSCALER;
  if (!autoscalerBinding) {
    return c.text(
      "AUTOSCALER binding not configured. Please add it to wrangler.jsonc",
      500,
    );
  }

  const autoscalerId = autoscalerBinding.idFromName("main");
  const autoscaler = autoscalerBinding.get(autoscalerId);

  // Forward the request to the autoscaler, which will route to the least loaded container
  return await autoscaler.fetch(c.req.raw);
});

export default app;
