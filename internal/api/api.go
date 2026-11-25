// Package api exposes the store over a JSON HTTP API. Authentication,
// offline sync and file storage come from the kit.
package api

import (
	"fmt"
	"net/http"

	"github.com/bhr-tools/getdone/internal/db"
	"github.com/bhr-tools/kit/auth"
	"github.com/bhr-tools/kit/httpx"
	"github.com/bhr-tools/kit/offline"
)

// sessionCookie keeps its first name: renaming it would sign everybody out.
const sessionCookie = "todo_session"

// API holds the HTTP handlers.
type API struct {
	store *db.Store
	auth  *auth.Auth
	sync  *offline.Sync
}

// New returns the API. With noAuth, every request is accepted without login.
func New(store *db.Store, noAuth bool) (*API, error) {
	a := &API{store: store}
	var err error
	if a.auth, err = auth.New(store.DB(), sessionCookie, noAuth); err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}
	if a.sync, err = offline.New(store.DB(), a.snapshot, a.dispatch); err != nil {
		return nil, fmt.Errorf("sync: %w", err)
	}
	return a, nil
}

// Helpers of the kit, under the names the handlers use.
var (
	writeJSON      = httpx.WriteJSON
	writeError     = httpx.WriteError
	fail           = httpx.Fail
	decode         = httpx.Decode
	optionalString = httpx.OptionalString
)

// Handler returns the API routes, wrapped in their middlewares.
func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	open := func(pattern string, h http.HandlerFunc) { mux.HandleFunc(pattern, h) }
	auth := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, a.auth.Require(h)) }

	a.auth.Routes(mux)
	a.sync.Routes(mux, a.auth.Require)

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
	auth("POST /api/tasks/{id}/attachments", a.uploadAttachments)
	open("GET /api/attachments/{id}", a.getAttachment) // session or signed link
	auth("DELETE /api/attachments/{id}", a.deleteAttachment)
	auth("POST /api/attachments/{id}/restore", a.restoreAttachment)

	auth("GET /api/search", a.search)
	auth("GET /api/counts", a.counts)

	open("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "Unknown API endpoint")
	})
	return httpx.RejectCrossSite(mux)
}
