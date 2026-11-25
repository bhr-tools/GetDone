package api

// Files attached to tasks. Uploads and deletions need the network; the list
// of attachments travels in the sync snapshot, each with a signed link. The
// files themselves are stored and served by the kit (kit/files).

import (
	"net/http"
	"time"

	"github.com/bhr-tools/getdone/internal/db"
	"github.com/bhr-tools/kit/files"
)

// uploadAttachments takes multipart/form-data with one or more "file" parts,
// streamed to disk one at a time, and answers the attachments added.
func (a *API) uploadAttachments(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("id")
	added := []db.Attachment{}
	ok := a.store.Files().ReadUploads(w, r, 4, func(u files.Upload) error {
		att, err := a.store.AddAttachment(taskID, u.Filename, u.ContentType, u.Body)
		if err != nil {
			return err
		}
		att.URL = a.fileLink(att.ID)
		added = append(added, att)
		return nil
	})
	if ok {
		writeJSON(w, http.StatusCreated, added)
	}
}

// getAttachment serves a file to a signed-in browser, or to anyone holding a
// valid signed link.
func (a *API) getAttachment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !a.auth.Authenticated(r) && !a.store.Files().ValidLink(r, id) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Authentication required", "auth_required": true})
		return
	}
	att, err := a.store.GetAttachment(id)
	if err != nil {
		fail(w, r, err)
		return
	}
	created, _ := time.Parse(time.RFC3339, att.CreatedAt)
	a.store.Files().Serve(w, r, att.ID, att.Filename, att.ContentType, created)
}

func (a *API) deleteAttachment(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteAttachment(r.PathValue("id")); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) restoreAttachment(w http.ResponseWriter, r *http.Request) {
	if err := a.store.RestoreAttachment(r.PathValue("id")); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// fileLink is the signed link of an attachment.
func (a *API) fileLink(id string) string {
	return a.store.Files().Link(files.LinkPath("/api/attachments/", id), id)
}
