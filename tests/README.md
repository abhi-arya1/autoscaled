# Autoscaled Test Suite

Test suite for the `autoscaled` package using Bun's test framework.

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

## Test Structure

```

tests/
├── app.test.ts # Main test file
├── package.json # Test dependencies
└── worker/ # Worker implementation
└── ...

```

```
