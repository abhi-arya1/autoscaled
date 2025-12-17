package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type Response struct {
	Message     string `json:"message"`
	InstanceID  string `json:"instance_id"`
	Timestamp   string `json:"timestamp"`
	RequestPath string `json:"request_path"`
}

func handler(w http.ResponseWriter, r *http.Request) {
	message := os.Getenv("MESSAGE")
	instanceId := os.Getenv("CLOUDFLARE_DURABLE_OBJECT_ID")

	response := Response{
		Message:     message,
		InstanceID:  instanceId,
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
		RequestPath: r.URL.Path,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":    "healthy",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func loadHandler(w http.ResponseWriter, r *http.Request) {
	// Simulate CPU-intensive work
	duration := 100 * time.Millisecond
	start := time.Now()
	for time.Since(start) < duration {
		// Busy wait to simulate CPU load
	}

	response := Response{
		Message:     "Load test completed",
		InstanceID:  os.Getenv("CLOUDFLARE_DURABLE_OBJECT_ID"),
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
		RequestPath: r.URL.Path,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func errorHandler(w http.ResponseWriter, r *http.Request) {
	panic("This is a panic")
}

func main() {
	// Listen for SIGINT and SIGTERM
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	router := http.NewServeMux()
	router.HandleFunc("/", handler)
	router.HandleFunc("/healthz", healthHandler)
	router.HandleFunc("/health", healthHandler)
	router.HandleFunc("/load", loadHandler)
	router.HandleFunc("/error", errorHandler)

	server := &http.Server{
		Addr:    ":8080",
		Handler: router,
	}

	go func() {
		log.Printf("Server listening on %s\n", server.Addr)
		log.Println("Available endpoints:")
		log.Println("  GET / - Basic handler")
		log.Println("  GET /healthz - Health check")
		log.Println("  GET /load - Simulate CPU load")
		log.Println("  GET /error - Trigger panic")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	// Wait to receive a signal
	sig := <-stop

	log.Printf("Received signal (%s), shutting down server...", sig)

	// Give the server 5 seconds to shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatal(err)
	}

	log.Println("Server shutdown successfully")
}
