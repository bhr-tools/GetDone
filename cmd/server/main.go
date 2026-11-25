// Command server runs Get Done: the JSON API and the embedded web app.
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/bhr-tools/getdone/internal/api"
	"github.com/bhr-tools/getdone/internal/db"
	"github.com/bhr-tools/getdone/web"
	"github.com/bhr-tools/kit/server"
)

// Each flag defaults to its environment variable (kit/server), so the binary
// is configured with flags (NixOS module) or environment alike.
func main() {
	cfg := server.Flags(8080, "getdone.db")
	flag.Parse()
	addr := cfg.Addr()

	store, err := db.Open(cfg.DBPath())
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer store.Close()
	a, err := api.New(store, cfg.NoAuth)
	if err != nil {
		log.Fatal(err)
	}
	go purgeAttachments(store)
	log.Printf("database %s", cfg.DBPath())
	server.Run("Get Done", addr, newHandler(store, a))
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

// newHandler routes the API, the health check, the kit files, the service
// worker and the web app (kit/server).
func newHandler(store *db.Store, a *api.API) http.Handler {
	return server.Handler(server.Options{API: a.Handler(), Web: web.Files, Ping: store.Ping, Offline: true})
}
