package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

type MonitorResponse struct {
	CPUUsage    float64 `json:"cpu_usage"`
	MemoryUsage float64 `json:"memory_usage"`
	DiskUsage   float64 `json:"disk_usage"`
}

func getCPUUsage() float64 {
	percent, err := cpu.Percent(100*time.Millisecond, false)
	if err != nil || len(percent) == 0 {
		return 0.0
	}
	return percent[0]
}

func getMemoryUsage() float64 {
	v, err := mem.VirtualMemory()
	if err != nil {
		return 0.0
	}
	return v.UsedPercent
}

func getDiskUsage() float64 {
	root := "/"
	if _, err := os.Stat("/"); os.IsNotExist(err) {
		root = "C:\\"
	}
	u, err := disk.Usage(root)
	if err != nil {
		return 0.0
	}
	return u.UsedPercent
}

func monitorHandler(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/monitorz":
		resp := MonitorResponse{
			CPUUsage:    getCPUUsage(),
			MemoryUsage: getMemoryUsage(),
			DiskUsage:   getDiskUsage(),
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)

	default:
		http.NotFound(w, r)
	}
}

func main() {
	port := flag.Int("port", 81, "Port to listen on")
	flag.Parse()

	// Check if we need to exec a command
	args := flag.Args()

	addr := fmt.Sprintf(":%d", *port)

	// Start HTTP server in background
	server := &http.Server{
		Addr:         addr,
		Handler:      http.HandlerFunc(monitorHandler),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		fmt.Fprintf(os.Stderr, "[monitor] Starting on port %d\n", *port)
		fmt.Fprintf(os.Stderr, "[monitor] Endpoint: GET http://localhost:%d/monitorz\n", *port)
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "[monitor] Server error: %v\n", err)
		}
	}()

	// Give server time to start
	time.Sleep(100 * time.Millisecond)

	if len(args) > 0 {
		// Exec mode: run the provided command
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		// Forward signals to child process
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

		if err := cmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "[monitor] Failed to start command: %v\n", err)
			os.Exit(1)
		}

		// Handle signals
		go func() {
			sig := <-sigChan
			cmd.Process.Signal(sig)
		}()

		// Wait for command to finish
		if err := cmd.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			os.Exit(1)
		}
	} else {
		// Standalone mode: just run the server
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		fmt.Fprintf(os.Stderr, "\n[monitor] Shutting down...\n")
	}
}
