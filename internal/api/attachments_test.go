package api

import (
	"bytes"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ben/get-done/internal/db"
)

func upload(t *testing.T, c *client, taskID, name string, content []byte, want int) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", name)
	fw.Write(content)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/tasks/"+taskID+"/attachments", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	rec := httptest.NewRecorder()
	c.handler.ServeHTTP(rec, req)
	if rec.Code != want {
		t.Fatalf("upload = %d, want %d: %s", rec.Code, want, rec.Body.String())
	}
	return rec
}

type attSync struct {
	Snapshot db.Snapshot `json:"snapshot"`
}

func TestAttachmentLifecycle(t *testing.T) {
	c, store := newClient(t, false)
	c.do("POST", "/api/auth/setup", map[string]any{"password": "correct horse"}, 200, nil)

	var task db.Task
	c.do("POST", "/api/tasks", map[string]any{"title": "Concert"}, 201, &task)
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	upload(t, c, task.ID, "ticket.png", png, 201)
	upload(t, c, "missing", "x.txt", []byte("x"), 404)
	upload(t, c, task.ID, "empty.txt", nil, 400)

	var snap attSync
	c.do("GET", "/api/sync", nil, 200, &snap)
	if len(snap.Snapshot.Attachments) != 1 {
		t.Fatalf("attachments = %+v", snap.Snapshot.Attachments)
	}
	att := snap.Snapshot.Attachments[0]
	if att.TaskID != task.ID || att.ContentType != "image/png" || att.Filename != "ticket.png" || !strings.Contains(att.URL, "sig=") {
		t.Fatalf("attachment = %+v", att)
	}

	// The signed link works without the session; a tampered one does not.
	anon := &client{t: t, handler: c.handler}
	rec := anon.do("GET", att.URL, nil, 200, nil)
	if !bytes.Equal(rec.Body.Bytes(), png) || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("download: %q %v", rec.Body.Bytes(), rec.Header())
	}
	anon.do("GET", strings.Replace(att.URL, "sig=", "sig=0", 1), nil, 401, nil)

	// Delete, restore.
	c.do("DELETE", "/api/attachments/"+att.ID, nil, 204, nil)
	c.do("GET", "/api/sync", nil, 200, &snap)
	if len(snap.Snapshot.Attachments) != 0 {
		t.Fatal("deleted attachment still listed")
	}
	c.do("POST", "/api/attachments/"+att.ID+"/restore", nil, 204, nil)

	// Completing the task hides the file; undo brings it back, the purge
	// only removes it once the retention has passed.
	var done db.Completion
	c.do("POST", "/api/tasks/"+task.ID+"/complete", map[string]any{}, 200, &done)
	c.do("GET", "/api/sync", nil, 200, &snap)
	if len(snap.Snapshot.Attachments) != 0 {
		t.Fatal("attachment of a completed task still listed")
	}
	if n, err := store.PurgeAttachments(time.Now().Add(-time.Hour)); err != nil || n != 0 {
		t.Fatalf("early purge = %d, %v", n, err)
	}
	c.do("POST", "/api/tasks/restore", map[string]any{"tasks": []*db.Task{done.Task}}, 200, nil)
	c.do("GET", "/api/sync", nil, 200, &snap)
	if len(snap.Snapshot.Attachments) != 1 {
		t.Fatal("undo did not bring the attachment back")
	}
	c.do("DELETE", "/api/tasks/"+task.ID, nil, 200, nil)
	if n, err := store.PurgeAttachments(time.Now().Add(time.Hour)); err != nil || n != 1 {
		t.Fatalf("purge = %d, %v", n, err)
	}
}
