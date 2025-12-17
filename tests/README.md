# Autoscaled Test Suite

Automated test suite for the `autoscaled` package using Bun's test framework.

## Running Tests

### Prerequisites

1. **Bun** installed (v1.3.3 or later)
2. **Worker running** (either locally via `wrangler dev` or deployed)

### Quick Start

1. **Start the worker** (in one terminal):

    ```bash
    cd worker
    bun run dev
    ```

2. **Run tests** (in another terminal):
    ```bash
    bun test
    ```

### Test Options

```bash
# Run tests once
bun test

# Run tests in watch mode
bun test --watch

# Run tests with custom worker URL
WORKER_URL=http://localhost:8787 bun test

# Run specific test file
bun test test.ts
```

## Test Coverage

The test suite covers:

- ✅ **Health Checks** - Worker and container health endpoints
- ✅ **Request Routing** - Basic routing through autoscaler
- ✅ **Load Balancing** - Distribution across multiple instances
- ✅ **Autoscaler Status** - Health endpoint with instance count
- ✅ **Load Testing** - CPU load simulation
- ✅ **Request-Based Scaling** - Multiple concurrent requests
- ✅ **Scaling Behavior** - Instance count during load
- ✅ **Error Handling** - Graceful error responses
- ✅ **Instance Information** - Response data validation

## Test Structure

```
tests/
├── test.ts          # Main test file
├── package.json     # Test dependencies
└── worker/          # Worker implementation
    └── ...
```

## Environment Variables

- `WORKER_URL` - URL of the running worker (default: `http://localhost:8787`)

## Writing New Tests

Tests use Bun's built-in test framework:

```typescript
import { describe, it, expect } from "bun:test";

describe("Feature Name", () => {
    it("should do something", async () => {
        const response = await fetch(`${WORKER_URL}/endpoint`);
        expect(response.ok).toBe(true);
    });
});
```

## Continuous Integration

Tests can be run in CI/CD pipelines:

```bash
# Start worker in background
cd worker && bun run dev &
WORKER_PID=$!

# Wait for worker to be ready
sleep 10

# Run tests
cd .. && bun test

# Cleanup
kill $WORKER_PID
```
