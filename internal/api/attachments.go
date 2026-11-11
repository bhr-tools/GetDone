package api

// Files attached to tasks. Uploads and deletions need the network; the list
// of attachments travels in the sync snapshot, each with a signed link.

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ben/get-done/internal/db"
)

const (
	maxAttachmentRequest = 4 * db.MaxAttachmentSize // several files per upload
	transferTimeout      = 10 * time.Minute         // a photo over a slow phone link
	linkLifetime         = 7 * 24 * time.Hour
)

// Types shown in the browser. Anything else is stored as
// application/octet-stream and always downloaded.
var inlineTypes = map[string]bool{
	"application/pdf": true,
	"image/png":       true,
	"image/jpeg":      true,
	"image/gif":       true,
	"image/webp":      true,
	"image/heic":      true,
	"image/heif":      true,
	"text/plain":      true,
}

// contentType decides the stored type from the content itself (and the
// extension for HEIC, which the standard sniffer does not know); the type
// the browser declared is not trusted.
func contentType(head []byte, filename string) string {
	sniffed, _, _ := strings.Cut(http.DetectContentType(head), ";")
	switch ext := strings.ToLower(filepath.Ext(filename)); {
	case inlineTypes[sniffed] && sniffed != "text/plain":
		return sniffed
	case sniffed == "text/plain" && (ext == ".txt" || ext == ".md" || ext == ".csv" || ext == ""):
		return "text/plain"
	case ext == ".heic" || ext == ".heif":
		return "image/" + ext[1:]
	}
	return "application/octet-stream"
}

// uploadAttachments takes multipart/form-data with one or more "file" parts,
// streamed to disk one at a time, and answers the attachments added.
func (a *API) uploadAttachments(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(transferTimeout))
	_ = rc.SetWriteDeadline(time.Now().Add(transferTimeout))
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentRequest)
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "Expected a multipart upload")
		return
	}
	taskID := r.PathValue("id")
	added := []db.Attachment{}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, http.StatusRequestEntityTooLarge, "Upload too large")
				return
			}
			writeError(w, http.StatusBadRequest, "Invalid upload")
			return
		}
		if part.FormName() == "file" {
			name := part.FileName()
			buf := bufio.NewReaderSize(part, 512)
			head, _ := buf.Peek(512)
			att, err := a.store.AddAttachment(taskID, name, contentType(head, name), buf)
			if err != nil {
				fail(w, r, err)
				return
			}
			att.URL = a.fileLink(att.ID)
			added = append(added, att)
		}
		part.Close()
	}
	if len(added) == 0 {
		writeError(w, http.StatusBadRequest, "No file uploaded")
		return
	}
	writeJSON(w, http.StatusCreated, added)
}

// getAttachment serves a file to a signed-in browser, or to anyone holding a
// valid signed link. Files run in a sandbox: an uploaded HTML or SVG page
// cannot script the app.
func (a *API) getAttachment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !a.authenticated(r) && !a.validLink(id, r.URL.Query().Get("exp"), r.URL.Query().Get("sig")) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Authentication required", "auth_required": true})
		return
	}
	att, f, err := a.store.OpenAttachment(id)
	if err != nil {
		fail(w, r, err)
		return
	}
	defer f.Close()
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(transferTimeout))

	disposition := "attachment"
	if inlineTypes[att.ContentType] {
		disposition = "inline"
	}
	h := w.Header()
	h.Set("Content-Type", att.ContentType)
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": att.Filename}))
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, max-age=86400")
	created, _ := time.Parse(time.RFC3339, att.CreatedAt)
	http.ServeContent(w, r, "", created, f)
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

// fileLink signs a link valid for at least linkLifetime. The expiry is
// rounded to the day, so a link stays the same, and cacheable, all day.
func (a *API) fileLink(id string) string {
	path := "/api/attachments/" + url.PathEscape(id)
	secret, err := a.store.LinkSecret()
	if err != nil {
		return path // still works for a signed-in browser
	}
	exp := time.Now().Add(linkLifetime).Truncate(24 * time.Hour).Add(24 * time.Hour).Unix()
	e := strconv.FormatInt(exp, 10)
	return fmt.Sprintf("%s?exp=%s&sig=%s", path, e, sign(secret, id, e))
}

func (a *API) validLink(id, exp, sig string) bool {
	e, err := strconv.ParseInt(exp, 10, 64)
	if err != nil || time.Now().Unix() > e {
		return false
	}
	secret, err := a.store.LinkSecret()
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(sign(secret, id, exp)), []byte(sig)) == 1
}

func sign(secret []byte, id, exp string) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(id + "|" + exp))
	return hex.EncodeToString(m.Sum(nil))
}
