// Package api exposes the store over a JSON HTTP API.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/ben/get-done/internal/db"
)

const (
	maxJSONBody   = 1 << 20  // 1 MiB
	maxUploadBody = 10 << 20 // 10 MiB
	sessionCookie = "todo_session"
)

// API holds the HTTP handlers.
type API struct {
	store  *db.Store
	noAuth bool
	// loginMu serializes password checks; a failed attempt holds it for a
	// moment, which caps brute-force attempts without any bookkeeping.
	loginMu sync.Mutex
}

// New returns the API. With noAuth, every request is accepted without login.
func New(store *db.Store, noAuth bool) *API {
	return &API{store: store, noAuth: noAuth}
}

// Handler returns the API routes, wrapped in their middlewares.
func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	open := func(pattern string, h http.HandlerFunc) { mux.HandleFunc(pattern, h) }
	auth := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, a.requireAuth(h)) }

	open("GET /api/auth/status", a.authStatus)
	open("POST /api/auth/setup", a.authSetup)
	open("POST /api/auth/login", a.authLogin)
	open("POST /api/auth/logout", a.authLogout)
	auth("POST /api/auth/change-password", a.authChangePassword)

	auth("GET /api/projects", a.listProjects)
	auth("POST /api/projects", a.createProject)
	auth("GET /api/projects/{id}", a.getProject)
	auth("PATCH /api/projects/{id}", a.renameProject)
	auth("DELETE /api/projects/{id}", a.deleteProject)
	auth("POST /api/projects/{id}/move", a.moveProject)
	auth("PUT /api/projects/{id}/sort", a.setProjectSort)
	auth("GET /api/projects/{id}/export", a.exportCSV)
	auth("POST /api/projects/{id}/import", a.importCSV)

	auth("GET /api/sections", a.listSections)
	auth("POST /api/sections", a.createSection)
	auth("PATCH /api/sections/{id}", a.renameSection)
	auth("DELETE /api/sections/{id}", a.deleteSection)
	auth("POST /api/sections/{id}/move", a.moveSection)

	auth("GET /api/tasks", a.listTasks)
	auth("POST /api/tasks", a.createTask)
	auth("POST /api/tasks/restore", a.restoreTasks)
	auth("GET /api/tasks/{id}", a.getTask)
	auth("PATCH /api/tasks/{id}", a.updateTask)
	auth("DELETE /api/tasks/{id}", a.deleteTask)
	auth("POST /api/tasks/{id}/move", a.moveTask)
	auth("POST /api/tasks/{id}/complete", a.completeTask)

	auth("GET /api/search", a.search)
	auth("GET /api/counts", a.counts)

	open("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "Unknown API endpoint")
	})
	return rejectCrossSite(mux)
}

// rejectCrossSite refuses state-changing requests sent by another site
// (CSRF). Browsers label every request with Sec-Fetch-Site; requests without
// it (curl, scripts) are not browser-driven and are let through.
func rejectCrossSite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeError(w, http.StatusForbidden, "Cross-site request refused")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.authenticated(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Authentication required", "auth_required": true})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authenticated reports whether r may use the API. Until a password is set,
// the instance is open (first-run setup).
func (a *API) authenticated(r *http.Request) bool {
	if a.noAuth {
		return true
	}
	hasPassword, err := a.store.HasPassword()
	if err != nil {
		return false
	}
	if !hasPassword {
		return true
	}
	c, err := r.Cookie(sessionCookie)
	return err == nil && a.store.ValidateSession(c.Value)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// fail answers with the status matching err: 404, 400 for invalid input, or
// 500 (logged, with a generic message).
func fail(w http.ResponseWriter, r *http.Request, err error) {
	var invalid *db.ValidationError
	switch {
	case errors.Is(err, db.ErrNotFound):
		writeError(w, http.StatusNotFound, "Not found")
	case errors.As(err, &invalid):
		writeError(w, http.StatusBadRequest, invalid.Msg)
	default:
		log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
		writeError(w, http.StatusInternalServerError, "Internal server error")
	}
}

// decode reads a JSON request body into dst. On failure it answers the
// request and returns false.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	body := http.MaxBytesReader(w, r.Body, maxJSONBody)
	if err := json.NewDecoder(body).Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			writeError(w, http.StatusRequestEntityTooLarge, "Request body too large")
		case errors.Is(err, io.EOF):
			writeError(w, http.StatusBadRequest, "Request body is empty")
		default:
			writeError(w, http.StatusBadRequest, "Invalid JSON: "+err.Error())
		}
		return false
	}
	return true
}

func optionalString(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}
