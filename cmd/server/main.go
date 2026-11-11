// Command server runs Get Done: the JSON API and the embedded web app.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ben/get-done/internal/api"
	"github.com/ben/get-done/internal/db"
	"github.com/ben/get-done/web"
)

// Each flag defaults to its environment variable, so the binary is configured
// with flags (NixOS module) or environment (container) alike.
func main() {
	host := flag.String("host", envOr("HOST", "127.0.0.1"), "listen address (env HOST)")
	port := flag.Int("port", envInt("PORT", 8080), "listen port (env PORT)")
	dataDir := flag.String("data-dir", envOr("DATA_DIR", "./data"), "directory of the database (env DATA_DIR)")
	dbPath := flag.String("db", os.Getenv("DB_PATH"), "database file, overrides -data-dir (env DB_PATH)")
	noAuth := flag.Bool("no-auth", envBool("NO_AUTH"), "disable the master password (env NO_AUTH=true)")
	flag.Parse()

	if *port < 1 || *port > 65535 {
		log.Fatalf("invalid port %d", *port)
	}
	path := *dbPath
	if path == "" {
		path = filepath.Join(*dataDir, "getdone.db")
	}

	store, err := db.Open(path)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer store.Close()
	go purgeAttachments(store)

	addr := net.JoinHostPort(*host, strconv.Itoa(*port))
	server := &http.Server{
		Addr:              addr,
		Handler:           newHandler(store, *noAuth),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("Get Done listening on http://%s (database %s)", addr, path)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Println("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

// purgeAttachments removes, once a day, the files deleted (or whose task was
// completed or deleted) more than db.AttachmentRetention ago.
func purgeAttachments(store *db.Store) {
	for {
		if n, err := store.PurgeAttachments(time.Now().Add(-db.AttachmentRetention)); err != nil {
			log.Printf("purge attachments: %v", err)
		} else if n > 0 {
			log.Printf("purged %d attachments", n)
		}
		time.Sleep(24 * time.Hour)
	}
}

// newHandler routes the API, the health check and the web app.
func newHandler(store *db.Store, noAuth bool) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/", api.New(store, noAuth).Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := store.Ping(); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		fmt.Fprintln(w, "ok")
	})
	mux.Handle("GET /sw.js", serviceWorker())
	mux.Handle("/", noCache(http.FileServerFS(web.Files)))
	return securityHeaders(mux)
}

// serviceWorker serves web/sw.js prefixed with the files to keep for offline
// use and a version that changes with any of them.
func serviceWorker() http.Handler {
	files := []string{}
	sum := sha256.New()
	err := fs.WalkDir(web.Files, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(web.Files, p)
		if err != nil {
			return err
		}
		sum.Write([]byte(p))
		sum.Write(b)
		if p == "index.html" {
			files = append(files, "/") // the file server answers "/" with index.html
		} else {
			files = append(files, "/"+p)
		}
		return nil
	})
	if err != nil {
		log.Fatalf("service worker: %v", err)
	}
	sum.Write([]byte(web.ServiceWorker))
	list, _ := json.Marshal(files)
	body := fmt.Sprintf("const VERSION = %q;\nconst FILES = %s;\n%s",
		hex.EncodeToString(sum.Sum(nil))[:16], list, web.ServiceWorker)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		io.WriteString(w, body)
	})
}

// noCache makes browsers revalidate the web app on every load, so an upgrade
// never mixes old and new JavaScript modules.
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Fatalf("invalid %s=%q: not a number", key, v)
	}
	return n
}

func envBool(key string) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return false
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		log.Fatalf("invalid %s=%q: expected true or false", key, v)
	}
	return b
}
