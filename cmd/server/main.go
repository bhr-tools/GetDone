package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ben/get-done/internal/api"
	"github.com/ben/get-done/internal/db"
	"github.com/ben/get-done/web"
)

func main() {
	var (
		portFlag          = flag.Int("port", 8080, "HTTP server port (or PORT env)")
		hostFlag          = flag.String("host", "127.0.0.1", "HTTP server host (or HOST env)")
		dataDirFlag       = flag.String("data-dir", "./data", "Directory for SQLite database (or DATA_DIR env)")
		dbPathFlag  = flag.String("db", "", "Path to SQLite database file (or DB_PATH env, overrides -data-dir)")
		noAuthFlag  = flag.Bool("no-auth", false, "Disable password authentication (or NO_AUTH=true env)")
	)
	flag.Parse()

	port := *portFlag
	if envPort := os.Getenv("PORT"); envPort != "" {
		fmt.Sscanf(envPort, "%d", &port)
	}

	host := *hostFlag
	if envHost := os.Getenv("HOST"); envHost != "" {
		host = envHost
	}

	dataDir := *dataDirFlag
	if envDataDir := os.Getenv("DATA_DIR"); envDataDir != "" {
		dataDir = envDataDir
	}

	dbPath := *dbPathFlag
	if envDB := os.Getenv("DB_PATH"); envDB != "" {
		dbPath = envDB
	}
	if dbPath == "" {
		dbPath = filepath.Join(dataDir, "getdone.db")
	}

	noAuth := *noAuthFlag
	if envNoAuth := os.Getenv("NO_AUTH"); envNoAuth == "1" || strings.EqualFold(envNoAuth, "true") {
		noAuth = true
	}

	store, err := db.NewStore(dbPath)
	if err != nil {
		log.Fatalf("❌ Failed to initialize database: %v", err)
	}
	defer store.Close()

	mux := http.NewServeMux()

	// Register API routes
	apiHandler := api.NewAPI(store, noAuth)
	apiHandler.RegisterRoutes(mux)

	// Web Static Files (embedded)
	webSubFS := web.Files
	fileServer := http.FileServer(http.FS(webSubFS))

	// Route frontend
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}

		// Try opening the file
		cleanPath := strings.TrimPrefix(r.URL.Path, "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		f, err := webSubFS.Open(cleanPath)
		if err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// SPA fallback to index.html
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})

	addr := fmt.Sprintf("%s:%d", host, port)
	server := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	log.Printf("✓ get-done starting on http://%s (db: %s)", addr, dbPath)

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("❌ HTTP server error: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("✓ get-done shutting down gracefully...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("❌ Server forced to shutdown: %v", err)
	}
	log.Println("✓ get-done stopped.")
}
