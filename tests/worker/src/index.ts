import { Container } from "@cloudflare/containers";
import { Hono } from "hono";
import { Autoscaler, routeContainerRequest } from "autoscaled";

export class MyContainer extends Container<Env> {
    defaultPort = 8080;
    requiredPorts = [8080, 81]; // Port 81 for monitor
    sleepAfter = "5m";
    envVars = {
        MESSAGE: "Hello from autoscaled container!",
    };

    override onStart() {
        console.log("Container started successfully");
    }

    override onStop() {
        console.log("Container stopped successfully");
    }

    override onError(error: unknown) {
        console.error("Container error:", error);
    }
}

// Autoscaler configuration with threshold-based scaling
export class MyAutoscaler extends Autoscaler<Env> {
    get config() {
        return {
            instance: "standard-1" as const,
            maxInstances: 5,
            minInstances: 1,
            containerBinding: this.env.MY_CONTAINER,
            // Scaling thresholds
            scaleThreshold: 75, // Scale up when any metric exceeds 75%
            scaleDownThreshold: 30, // Scale down when all metrics below 30%
            // Cooldown periods
            scaleUpCooldown: 30_000, // 30 seconds
            scaleDownCooldown: 60_000, // 60 seconds
            // Request-based scaling
            maxRequestsPerInstance: 10,
            // Health check configuration
            healthCheckRetries: 3,
            // Monitoring
            monitoringEndpoint: "/healthz",
            monitorzURL: "http://localhost:81/monitorz",
            keepAliveEndpoint: "/healthz",
            // Heartbeat configuration
            heartbeatInterval: 15_000, // 15 seconds
            staleThreshold: 60_000, // 1 minute
        };
    }
}

const app = new Hono<{
    Bindings: Env;
}>();

// Root endpoint - API documentation
app.get("/", (c) => {
    return c.json({
        name: "Autoscaled Test Worker",
        description: "Comprehensive test suite for autoscaler features",
        endpoints: {
            "/": "This documentation",
            "/autoscaler/*":
                "Route through autoscaler (load balances and auto-scales)",
            "/health": "Worker health check",
            "/test/*": "Test endpoints (see /test for details)",
        },
        features: [
            "Threshold-based scaling (CPU, Memory, Disk)",
            "Request-based scaling",
            "Scale-up/scale-down cooldowns",
            "Hysteresis (different thresholds for up/down)",
            "Graceful draining",
            "Health check retries",
            "Keep-alive mechanism",
        ],
    });
});

// Worker health check
app.get("/health", (c) => {
    return c.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
    });
});

// Test endpoints
app.get("/test", (c) => {
    return c.json({
        description: "Test endpoints for autoscaler features",
        endpoints: {
            "/test/basic": "Basic request (no load)",
            "/test/load": "Simulate CPU load (triggers scaling)",
            "/test/many": "Send many requests (tests request-based scaling)",
            "/test/health": "Check container health endpoint",
            "/test/metrics": "Get container metrics via monitorz",
        },
    });
});

// Basic test endpoint
app.get("/test/basic", async (c) => {
    const response = await routeContainerRequest(c.req.raw, c.env.AUTOSCALER);
    if (!response) {
        return c.text("Failed to route request", 500);
    }
    return response;
});

// Load test endpoint (simulates CPU-intensive work)
app.get("/test/load", async (c) => {
    const url = new URL(c.req.url);
    url.pathname = "/load";
    const loadRequest = new Request(url.toString(), c.req.raw);
    const response = await routeContainerRequest(loadRequest, c.env.AUTOSCALER);
    if (!response) {
        return c.text("Failed to route request", 500);
    }
    return response;
});

// Many requests test (for request-based scaling) - sequential
app.get("/test/many", async (c) => {
    const count = parseInt(c.req.query("count") || "10");
    const results = [];

    for (let i = 0; i < count; i++) {
        try {
            const response = await routeContainerRequest(
                c.req.raw,
                c.env.AUTOSCALER,
            );
            if (response) {
                const data = (await response.json()) as any;
                results.push({ request: i + 1, instance: data.instance_id });
            }
        } catch (error) {
            results.push({ request: i + 1, error: String(error) });
        }
    }

    return c.json({
        total_requests: count,
        results,
    });
});

// Concurrent requests test (for request-based scaling) - sends all requests concurrently
app.get("/test/concurrent", async (c) => {
    const count = parseInt(c.req.query("count") || "15");

    // Send all requests concurrently to trigger request-based scaling
    const requests = Array.from({ length: count }, () =>
        routeContainerRequest(c.req.raw, c.env.AUTOSCALER),
    );

    const responses = await Promise.allSettled(requests);
    const results = responses.map((result, i) => {
        if (result.status === "fulfilled" && result.value) {
            return { request: i + 1, status: "success" };
        } else {
            const error =
                result.status === "rejected" ? result.reason : "unknown";
            return { request: i + 1, status: "failed", error: String(error) };
        }
    });

    return c.json({
        total_requests: count,
        concurrent: true,
        results,
    });
});

// Health check test - route to /health (container endpoint, not autoscaler's /healthz)
app.get("/test/health", async (c) => {
    const url = new URL(c.req.url);
    url.pathname = "/health"; // Use /health instead of /healthz to avoid autoscaler interception
    const healthRequest = new Request(url.toString(), c.req.raw);
    const response = await routeContainerRequest(
        healthRequest,
        c.env.AUTOSCALER,
    );
    if (!response) {
        return c.text("Failed to route request", 500);
    }
    return response;
});

// Metrics test (via monitorz)
app.get("/test/metrics", async (c) => {
    // This would need to be done through the autoscaler's monitoring endpoint
    // For now, route to a container and check its metrics
    const url = new URL(c.req.url);
    url.pathname = "/";
    const metricsRequest = new Request(url.toString(), c.req.raw);
    const response = await routeContainerRequest(
        metricsRequest,
        c.env.AUTOSCALER,
    );
    if (!response) {
        return c.text("Failed to route request", 500);
    }
    return response;
});

// Autoscaler health endpoint - routes to autoscaler's /healthz
app.get("/autoscaler/healthz", async (c) => {
    const autoscalerBinding = c.env.AUTOSCALER;
    if (!autoscalerBinding) {
        return c.json(
            {
                error: "AUTOSCALER binding not configured",
                message: "Please add AUTOSCALER to wrangler.jsonc",
            },
            500,
        );
    }

    // Create a request to /healthz (autoscaler's monitoringEndpoint)
    // The autoscaler will handle this and return health data
    const healthzUrl = new URL(c.req.url);
    healthzUrl.pathname = "/healthz";
    const healthzRequest = new Request(healthzUrl.toString(), {
        method: "GET",
        headers: c.req.header(),
    });

    const response = await routeContainerRequest(
        healthzRequest,
        autoscalerBinding,
    );
    if (!response || !response.ok) {
        return c.json({ error: "Failed to get autoscaler health" }, 500);
    }
    return response;
});

export default app;
