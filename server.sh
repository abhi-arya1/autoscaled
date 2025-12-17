#!/bin/bash

# Simple HTTP monitoring server
# Endpoint: GET /monitor - Returns CPU, Memory, and Disk usage
# Designed to run as a background process in any Docker container
#
# Usage:
#   Start monitor and run command: ./monitor-server.sh exec your-command
#   Start monitor only: ./monitor-server.sh
#   Examples:
#     ./monitor-server.sh exec node app.js
#     ./monitor-server.sh exec python app.py
#     ./monitor-server.sh exec ./myapp

PORT=${PORT:-8080}

get_cpu_usage() {
    # Get CPU usage using top command (1 second sample)
    if command -v top >/dev/null 2>&1; then
        cpu=$(top -bn2 -d 0.5 2>/dev/null | grep "Cpu(s)" | tail -1 | awk '{print $2}' | cut -d'%' -f1)
        [ -z "$cpu" ] && cpu="0.0"
    else
        cpu="N/A"
    fi
    echo "$cpu"
}

get_memory_usage() {
    # Get memory usage percentage
    if command -v free >/dev/null 2>&1; then
        mem=$(free | grep Mem | awk '{printf "%.2f", ($3/$2) * 100.0}')
        [ -z "$mem" ] && mem="0.0"
    else
        mem="N/A"
    fi
    echo "$mem"
}

get_disk_usage() {
    # Get disk usage for root filesystem
    if command -v df >/dev/null 2>&1; then
        disk=$(df -h / | tail -1 | awk '{print $5}' | sed 's/%//')
        [ -z "$disk" ] && disk="0"
    else
        disk="N/A"
    fi
    echo "$disk"
}

handle_request() {
    # Read the HTTP request
    read -r request
    
    # Extract method and path
    method=$(echo "$request" | awk '{print $1}')
    path=$(echo "$request" | awk '{print $2}')
    
    # Consume remaining headers
    while read -r header; do
        [ "$header" = $'\r' ] && break
    done
    
    # Handle /monitor endpoint
    if [ "$method" = "GET" ] && [ "$path" = "/monitor" ]; then
        cpu=$(get_cpu_usage)
        memory=$(get_memory_usage)
        disk=$(get_disk_usage)
        
        # Build JSON response
        json="{\"cpu_usage\":\"${cpu}%\",\"memory_usage\":\"${memory}%\",\"disk_usage\":\"${disk}%\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
        
        # Send HTTP response
        echo -ne "HTTP/1.1 200 OK\r\n"
        echo -ne "Content-Type: application/json\r\n"
        echo -ne "Content-Length: ${#json}\r\n"
        echo -ne "Connection: close\r\n"
        echo -ne "\r\n"
        echo -ne "$json"
    else
        # 404 for other paths
        body="Not Found"
        echo -ne "HTTP/1.1 404 Not Found\r\n"
        echo -ne "Content-Type: text/plain\r\n"
        echo -ne "Content-Length: ${#body}\r\n"
        echo -ne "Connection: close\r\n"
        echo -ne "\r\n"
        echo -ne "$body"
    fi
}

start_monitor() {
    echo "[monitor] Starting monitoring server on port $PORT..." >&2
    echo "[monitor] Endpoint: GET http://localhost:$PORT/monitor" >&2

    # Detect which netcat is available
    if command -v nc >/dev/null 2>&1; then
        NC_CMD="nc"
    elif command -v netcat >/dev/null 2>&1; then
        NC_CMD="netcat"
    else
        echo "[monitor] ERROR: netcat (nc) not found. Please install netcat." >&2
        exit 1
    fi

    # Start the server using netcat
    # Try different netcat syntaxes for compatibility
    while true; do
        # Try BSD-style netcat first (common in Alpine)
        if handle_request | $NC_CMD -l -p "$PORT" 2>/dev/null; then
            continue
        fi
        # Try GNU-style netcat
        if handle_request | $NC_CMD -l "$PORT" 2>/dev/null; then
            continue
        fi
        # If both fail, wait a bit and retry
        sleep 1
    done
}

# Main logic
if [ "$1" = "exec" ]; then
    # Start monitor in background and exec into the provided command
    shift
    start_monitor &
    MONITOR_PID=$!
    
    # Cleanup function
    cleanup() {
        echo "[monitor] Stopping monitoring server..." >&2
        kill $MONITOR_PID 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM
    
    # Execute the provided command
    exec "$@"
else
    # Just run the monitor (foreground)
    start_monitor
fi