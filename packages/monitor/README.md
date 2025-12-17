# Monitor

Lightweight cross-platform HTTP server that can be used to monitor container resources for autoscaling.

## Features

- CPU, memory, and disk usage metrics via HTTP API
- Works on Windows, Linux, macOS, BSD, and more
- Standalone or exec mode (monitor alongside other processes)
- Health check endpoint

## Usage

> Default port is 81, but can be changed with the -port flag.

### Install Dependencies

```bash
go mod tidy
```

### Standalone Mode

```bash
go run main.go
go run main.go -port 8080
```

### Exec Mode

Run monitor alongside another command for multiple processes:

```bash
go run main.go node app.js
go run main.go python app.py
```

### Build

```bash
go build -o monitor main.go
./monitor

# Exec mode with build
./monitor -port 8080
./monitor node app.js
./monitor python app.py
```

To build for a specific platform, set the following variables:

```bash
GOOS=linux GOARCH=amd64 go build -o monitor main.go
```

Where `GOOS` and `GOARCH` are the operating system and architecture you want to build for.

## API

**GET /monitorz** - System metrics:

```json
{
    "cpu_usage": "45.2",
    "memory_usage": "62.8",
    "disk_usage": "34.1"
}
```

These are all percentages on a 0-100 scale.

## Requirements

- Go 1.25 or later
