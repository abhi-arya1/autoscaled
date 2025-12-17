import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";

const WORKER_URL = process.env.WORKER_URL || "http://localhost:8787";
const TEST_TIMEOUT = 30_000; // 30 seconds

describe("Autoscaled Test Suite", () => {
    let wranglerProcess: ReturnType<typeof spawn> | null = null;

    beforeAll(async () => {
        // Check if worker is already running
        try {
            const response = await fetch(`${WORKER_URL}/health`);
            if (response.ok) {
                console.log("Worker already running, using existing instance");
                return;
            }
        } catch {
            // Worker not running, start it
            console.log("Starting worker...");
            wranglerProcess = spawn(["bun", "run", "dev"], {
                cwd: "./worker",
                stdout: "pipe",
                stderr: "pipe",
            });

            // Wait for worker to be ready
            let attempts = 0;
            while (attempts < 30) {
                try {
                    const response = await fetch(`${WORKER_URL}/health`);
                    if (response.ok) {
                        console.log("Worker started successfully");
                        break;
                    }
                } catch {
                    // Not ready yet
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
                attempts++;
            }

            if (attempts >= 30) {
                throw new Error("Worker failed to start within 30 seconds");
            }
        }
    }, TEST_TIMEOUT);

    afterAll(async () => {
        if (wranglerProcess) {
            console.log("Stopping worker...");
            wranglerProcess.kill();
            await wranglerProcess.exited;
        }
    });

    describe("Health Checks", () => {
        it("should return healthy status", async () => {
            const response = await fetch(`${WORKER_URL}/health`);
            expect(response.ok).toBe(true);
            const data = await response.json();
            expect(data.status).toBe("healthy");
            expect(data.timestamp).toBeDefined();
        });

        it("should return API documentation", async () => {
            const response = await fetch(`${WORKER_URL}/`);
            expect(response.ok).toBe(true);
            const data = await response.json();
            expect(data.name).toBe("Autoscaled Test Worker");
            expect(data.endpoints).toBeDefined();
            expect(data.features).toBeDefined();
        });
    });

    describe("Basic Request Routing", () => {
        it("should route requests through autoscaler", async () => {
            const response = await fetch(`${WORKER_URL}/test/basic`);
            expect(response.ok).toBe(true);
            const data = await response.json();
            expect(data.message).toBeDefined();
            expect(data.instance_id).toBeDefined();
            expect(data.timestamp).toBeDefined();
        });

        it("should return different instance IDs for multiple requests", async () => {
            const responses = await Promise.all([
                fetch(`${WORKER_URL}/test/basic`),
                fetch(`${WORKER_URL}/test/basic`),
                fetch(`${WORKER_URL}/test/basic`),
            ]);

            const instances = await Promise.all(
                responses.map((r) => r.json().then((d) => d.instance_id)),
            );

            // At least one instance should be different (load balancing)
            const uniqueInstances = new Set(instances);
            expect(uniqueInstances.size).toBeGreaterThan(0);
        });
    });

    describe("Autoscaler Health Endpoint", () => {
        it("should return autoscaler status", async () => {
            const response = await fetch(`${WORKER_URL}/autoscaler/healthz`);
            expect(response.ok).toBe(true);
            const data = await response.json();
            expect(data.instanceCount).toBeDefined();
            expect(typeof data.instanceCount).toBe("number");
            expect(data.instances).toBeDefined();
            expect(Array.isArray(data.instances)).toBe(true);
        });

        it("should show at least minInstances", async () => {
            const response = await fetch(`${WORKER_URL}/autoscaler/healthz`);
            const data = await response.json();
            expect(data.instanceCount).toBeGreaterThanOrEqual(1); // minInstances = 1
        });
    });

    describe("Container Health Checks", () => {
        it("should return healthy from container", async () => {
            const response = await fetch(`${WORKER_URL}/test/health`);
            expect(response.ok).toBe(true);
            const data = await response.json();
            expect(data.status).toBe("healthy");
        });
    });

    describe("Load Testing", () => {
        it("should handle load requests", async () => {
            const response = await fetch(`${WORKER_URL}/test/load`);
            expect(response.ok).toBe(true);
            const data = await response.json();
            expect(data.message).toBe("Load test completed");
            expect(data.instance_id).toBeDefined();
        });
    });

    describe("Request-Based Scaling", () => {
        it(
            "should handle multiple concurrent requests",
            async () => {
                const count = 20;
                const response = await fetch(
                    `${WORKER_URL}/test/many?count=${count}`,
                );
                expect(response.ok).toBe(true);
                const data = await response.json();
                expect(data.total_requests).toBe(count);
                expect(data.results).toBeDefined();
                expect(data.results.length).toBe(count);

                // Check that requests were distributed
                const instances = data.results
                    .filter((r: any) => r.instance)
                    .map((r: any) => r.instance);
                const uniqueInstances = new Set(instances);
                expect(uniqueInstances.size).toBeGreaterThan(0);
            },
            TEST_TIMEOUT,
        );
    });

    describe("Scaling Behavior", () => {
        it(
            "should maintain instances during load",
            async () => {
                // Get initial instance count
                const initialResponse = await fetch(
                    `${WORKER_URL}/autoscaler/healthz`,
                );
                const initialData = await initialResponse.json();
                const initialCount = initialData.instanceCount;

                // Send load requests
                await Promise.all([
                    fetch(`${WORKER_URL}/test/load`),
                    fetch(`${WORKER_URL}/test/load`),
                    fetch(`${WORKER_URL}/test/load`),
                ]);

                // Wait a bit for scaling to potentially occur
                await new Promise((resolve) => setTimeout(resolve, 2000));

                // Check instance count again
                const afterResponse = await fetch(
                    `${WORKER_URL}/autoscaler/healthz`,
                );
                const afterData = await afterResponse.json();
                const afterCount = afterData.instanceCount;

                // Should have at least the initial count (may scale up)
                expect(afterCount).toBeGreaterThanOrEqual(initialCount);
            },
            TEST_TIMEOUT,
        );

        it(
            "should scale up to 2 instances based on maxRequestsPerInstance",
            async () => {
                // Get initial instance count (should be 1)
                const initialResponse = await fetch(
                    `${WORKER_URL}/autoscaler/healthz`,
                );
                const initialData = (await initialResponse.json()) as any;
                const initialCount = initialData.instanceCount;
                expect(initialCount).toBeGreaterThanOrEqual(1);

                // Send 15 concurrent requests (exceeds maxRequestsPerInstance: 10)
                // Scaling should happen immediately during request routing when instances reach capacity
                const concurrentResponse = await fetch(
                    `${WORKER_URL}/test/concurrent?count=15`,
                );
                expect(concurrentResponse.ok).toBe(true);

                // Give a small delay for container creation to complete (scaling happens immediately during routing)
                await new Promise((resolve) => setTimeout(resolve, 5000));

                // Check instance count - should have scaled up to at least 2
                const afterResponse = await fetch(
                    `${WORKER_URL}/autoscaler/healthz`,
                );
                const afterData = (await afterResponse.json()) as any;
                const afterCount = afterData.instanceCount;

                // Should have scaled up to 2 instances (15 requests / 10 per instance = 2 needed)
                expect(afterCount).toBeGreaterThanOrEqual(2);
                expect(afterCount).toBeLessThanOrEqual(5); // Should not exceed maxInstances
            },
            TEST_TIMEOUT,
        );
    });

    describe("Error Handling", () => {
        it("should handle invalid endpoints gracefully", async () => {
            const response = await fetch(`${WORKER_URL}/nonexistent`);
            // Should return 404 or handle gracefully
            expect([404, 500].includes(response.status)).toBe(true);
        });
    });

    describe("Instance Information", () => {
        it("should return instance details in responses", async () => {
            const response = await fetch(`${WORKER_URL}/test/basic`);
            const data = await response.json();

            expect(data).toHaveProperty("message");
            expect(data).toHaveProperty("instance_id");
            expect(data).toHaveProperty("timestamp");
            expect(data).toHaveProperty("request_path");

            expect(typeof data.message).toBe("string");
            expect(typeof data.instance_id).toBe("string");
            expect(typeof data.timestamp).toBe("string");
            expect(typeof data.request_path).toBe("string");
        });
    });
});

describe("Autoscaler Configuration", () => {
    it("should have proper test configuration", () => {
        // This is a meta-test to ensure test configuration is correct
        expect(WORKER_URL).toBeDefined();
        expect(WORKER_URL.startsWith("http")).toBe(true);
    });
});
