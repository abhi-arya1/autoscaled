# Test Suite

Test suite for the `autoscaled` package, demonstrating threshold-based scaling, graceful draining, health checks, and more.

## Overview

This test worker demonstrates the full capabilities of the autoscaled autoscaler:

- **Threshold-based scaling** (CPU, Memory, Disk)
- **Request-based scaling** (max requests per instance)
- **Scale-up/scale-down cooldowns** (prevents thrashing)
- **Hysteresis** (different thresholds for up vs down)
- **Graceful draining** (waits for active requests before removal)
- **Health check retries** (avoids false negatives)
- **Keep-alive mechanism** (prevents unexpected shutdowns)

## Prerequisites

1. **Node.js** and **npm** (or **bun**)
2. **Wrangler CLI** (Cloudflare Workers CLI)
3. **Go** (for building the monitor executable, if not pre-built)
4. **Docker** (for building container images)
5. **Cloudflare account** with Workers and Containers enabled

## Setup

### 1. Install Dependencies

```bash
npm install
# or
bun install
```

### 2. Build Monitor Executable (if needed)

The Dockerfile expects a pre-built monitor executable at `../../packages/monitor/monitor`. If it doesn't exist, build it:

```bash
cd ../../packages/monitor
go build -o monitor main.go
cd ../../tests/worker
```

The monitor executable will be copied into the Docker image and used in exec mode to start the container server.

### 3. Generate TypeScript Types

```bash
npm run cf-typegen
# or
bun run cf-typegen
```

## Running Tests

### Local Development

Start the development server:

```bash
npm run dev
# or
bun run dev
```

This will:

- Start Wrangler dev server
- Build the Docker image (includes monitor + server)
- Start the autoscaler with test configuration
-

## Test Endpoints

Once running, you can test various autoscaler features:

### Documentation

- `GET /` - API documentation and available endpoints
- `GET /test` - Test endpoints documentation

### Basic Tests

- `GET /test/basic` - Basic request routing through autoscaler
- `GET /test/load` - Simulate CPU load (triggers scaling)
- `GET /test/many?count=20` - Send multiple requests (tests request-based scaling)

### Health & Metrics

- `GET /test/health` - Check container health endpoint
- `GET /autoscaler/healthz` - Autoscaler health check (shows instance count and status)

## Test Configuration

The autoscaler is configured with:

```typescript
{
  instance: "standard-1",
  maxInstances: 5,
  minInstances: 1,
  scaleThreshold: 75,           // Scale up at 75%
  scaleDownThreshold: 30,      // Scale down at 30%
  scaleUpCooldown: 30_000,      // 30 seconds
  scaleDownCooldown: 60_000,    // 60 seconds
  maxRequestsPerInstance: 10,
  healthCheckRetries: 3,
  heartbeatInterval: 15_000,    // 15 seconds
}
```

## Container Setup

The container includes:

- **Server** (port 8080) - Main application server
- **Monitor** (port 81) - Metrics endpoint (`/monitorz`)

The Dockerfile:

1. Builds the Go server from `container_src/`
2. Copies the pre-built monitor executable
3. Uses monitor in exec mode: `/monitor -port 81 /server`

## Testing Autoscaling

### Test Scale-Up

1. Send load requests to trigger scaling:

    ```bash
    curl http://localhost:8787/test/load
    ```

2. Send many requests to test request-based scaling:

    ```bash
    curl "http://localhost:8787/test/many?count=50"
    ```

3. Check autoscaler status:
    ```bash
    curl http://localhost:8787/autoscaler/healthz
    ```

### Test Scale-Down

1. Wait for cooldown period (60 seconds)
2. Ensure all instances are below 30% threshold
3. Autoscaler will gracefully drain and remove instances

### Test Graceful Draining

1. Send requests to an instance
2. Trigger scale-down
3. Instance will be marked as draining
4. New requests won't route to draining instance
5. Instance waits for active requests to complete before removal

## Monitoring

The autoscaler fetches metrics from each container via:

- `http://localhost:81/monitorz` - Returns CPU, memory, and disk usage percentages

Health checks are performed via:

- `/healthz` - Container health endpoint

## Troubleshooting

### Monitor executable not found

If you see errors about the monitor executable:

1. Build it: `cd ../../packages/monitor && go build -o monitor main.go`
2. Ensure it's executable: `chmod +x monitor`

### Container build fails

Ensure:

- Docker is running
- Monitor executable exists at `../../packages/monitor/monitor`
- Go modules are downloaded in `container_src/`

### Autoscaler not scaling

Check:

- Metrics are being fetched (check logs)
- Thresholds are configured correctly
- Cooldown periods haven't expired
- Instance count hasn't reached `maxInstances`

## Architecture

```
Worker (Hono)
  ↓
Autoscaler (Durable Object)
  ├─ Routes requests to least loaded container
  ├─ Monitors metrics (CPU, Memory, Disk)
  ├─ Scales up/down based on thresholds
  └─ Manages instance lifecycle
      ↓
Container Instances
  ├─ Server (port 8080) - Application
  └─ Monitor (port 81) - Metrics endpoint
```

## Files

- `src/index.ts` - Worker and autoscaler configuration
- `container_src/main.go` - Container application server
- `Dockerfile` - Container image build (includes monitor)
- `wrangler.jsonc` - Wrangler configuration
