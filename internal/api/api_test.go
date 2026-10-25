package api

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ben/get-done/internal/db"
)

type client struct {
	t       *testing.T
	handler http.Handler
	cookie  *http.Cookie
}

func newClient(t *testing.T, noAuth bool) (*client, *db.Store) {
	t.Helper()
	store, err := db.Open(filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return &client{t: t, handler: New(store, noAuth).Handler()}, store
}

// do sends a request and decodes the JSON answer into out (when not nil).
func (c *client) do(method, path string, body any, wantStatus int, out any) *httptest.ResponseRecorder {
	c.t.Helper()
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	rec := httptest.NewRecorder()
	c.handler.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		c.t.Fatalf("%s %s = %d, want %d: %s", method, path, rec.Code, wantStatus, rec.Body.String())
	}
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == sessionCookie {
			c.cookie = ck
			if ck.MaxAge < 0 {
				c.cookie = nil
			}
		}
	}
	if out != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			c.t.Fatalf("decode %s %s: %v", method, path, err)
		}
	}
	return rec
}

func TestTaskLifecycle(t *testing.T) {
	c, _ := newClient(t, true)

	var proj db.Project
	c.do("POST", "/api/projects", map[string]any{"name": "Home"}, 201, &proj)
	var sec db.Section
	c.do("POST", "/api/sections", map[string]any{"project_id": proj.ID, "name": "Kitchen"}, 201, &sec)

	var parent, child db.Task
	c.do("POST", "/api/tasks", map[string]any{"title": "Clean", "project_id": proj.ID, "section_id": sec.ID, "due_date": "2026-10-08"}, 201, &parent)
	c.do("POST", "/api/tasks", map[string]any{"title": "Oven", "parent_id": parent.ID}, 201, &child)
	if child.ProjectID != proj.ID {
		t.Fatalf("subtask project = %s", child.ProjectID)
	}

	// Validation errors are 400 with a readable message.
	rec := c.do("POST", "/api/tasks", map[string]any{"title": "x", "due_date": "tomorrow"}, 400, nil)
	if !strings.Contains(rec.Body.String(), "Invalid due date") {
		t.Fatalf("unexpected error body: %s", rec.Body.String())
	}
	c.do("POST", "/api/tasks", "not an object", 400, nil)
	c.do("GET", "/api/tasks/missing", nil, 404, nil)

	// Patch keeps absent fields and clears null ones.
	var patched db.Task
	c.do("PATCH", "/api/tasks/"+parent.ID, map[string]any{"priority": 1, "location": "Home"}, 200, &patched)
	if patched.Priority != 1 || *patched.Location != "Home" || *patched.DueDate != "2026-10-08" {
		t.Fatalf("patch result: %+v", patched)
	}
	c.do("PATCH", "/api/tasks/"+parent.ID, map[string]any{"location": nil}, 200, &patched)
	if patched.Location != nil {
		t.Fatal("location not cleared")
	}

	// Lists, counts and search.
	var list []*db.Task
	c.do("GET", "/api/tasks?view=project&project_id="+proj.ID, nil, 200, &list)
	if len(list) != 1 || len(list[0].Subtasks) != 1 {
		t.Fatalf("project tree: %+v", list)
	}
	c.do("GET", "/api/tasks?view=upcoming&today=2026-10-07", nil, 200, &list)
	if len(list) != 1 {
		t.Fatalf("upcoming: %d tasks", len(list))
	}
	var counts db.Counts
	c.do("GET", "/api/counts?today=2026-10-08", nil, 200, &counts)
	if counts.Upcoming != 1 || counts.Projects[proj.ID] != "today" {
		t.Fatalf("counts: %+v", counts)
	}
	c.do("GET", "/api/search?q=oven", nil, 200, &list)
	if len(list) != 1 || list[0].ProjectName != "Home" {
		t.Fatalf("search: %+v", list)
	}

	// Move the subtask out to the root of the inbox.
	var moved db.Task
	c.do("POST", "/api/tasks/"+child.ID+"/move", map[string]any{"project_id": "inbox"}, 200, &moved)
	if moved.ParentID != nil || moved.ProjectID != "inbox" {
		t.Fatalf("move: %+v", moved)
	}

	// Complete, then undo.
	var done db.Completion
	c.do("POST", "/api/tasks/"+parent.ID+"/complete", map[string]any{"today": "2026-10-07"}, 200, &done)
	if !done.Deleted {
		t.Fatal("one-off task must be deleted on completion")
	}
	c.do("GET", "/api/tasks/"+parent.ID, nil, 404, nil)
	c.do("POST", "/api/tasks/restore", map[string]any{"tasks": []*db.Task{done.Task}}, 200, nil)
	c.do("GET", "/api/tasks/"+parent.ID, nil, 200, nil)

	// Sort is validated and persisted, also for the inbox.
	c.do("PUT", "/api/projects/inbox/sort", map[string]any{"sort_by": "title"}, 200, nil)
	c.do("PUT", "/api/projects/inbox/sort", map[string]any{"sort_by": "chaos"}, 400, nil)
	var inbox db.Project
	c.do("GET", "/api/projects/inbox", nil, 200, &inbox)
	if inbox.SortBy != "title" {
		t.Fatalf("inbox sort = %q", inbox.SortBy)
	}

	c.do("DELETE", "/api/projects/inbox", nil, 400, nil)
	c.do("DELETE", "/api/projects/"+proj.ID, nil, 200, nil)
	c.do("GET", "/api/nothing", nil, 404, nil)
}

func TestAuthFlow(t *testing.T) {
	c, _ := newClient(t, false)
	var status map[string]bool
	c.do("GET", "/api/auth/status", nil, 200, &status)
	if status["has_password"] || status["authenticated"] {
		t.Fatalf("fresh status: %v", status)
	}
	// Before setup, the instance is open.
	c.do("GET", "/api/projects", nil, 200, nil)

	c.do("POST", "/api/auth/setup", map[string]any{"password": "ab"}, 400, nil)
	c.do("POST", "/api/auth/setup", map[string]any{"password": "correct horse"}, 200, nil)
	c.do("POST", "/api/auth/setup", map[string]any{"password": "hijack"}, 400, nil)
	c.do("GET", "/api/projects", nil, 200, nil)

	c.do("POST", "/api/auth/logout", nil, 200, nil)
	rec := c.do("GET", "/api/projects", nil, 401, nil)
	if !strings.Contains(rec.Body.String(), "auth_required") {
		t.Fatal("401 must say auth_required")
	}
	c.do("POST", "/api/auth/login", map[string]any{"password": "wrong"}, 401, nil)
	c.do("POST", "/api/auth/login", map[string]any{"password": "correct horse"}, 200, nil)
	c.do("POST", "/api/auth/change-password", map[string]any{"old_password": "nope", "new_password": "battery staple"}, 401, nil)
	c.do("POST", "/api/auth/change-password", map[string]any{"old_password": "correct horse", "new_password": "battery staple"}, 200, nil)
	c.do("GET", "/api/projects", nil, 200, nil) // still signed in after the change
}

func TestCrossSiteRequestsAreRefused(t *testing.T) {
	c, _ := newClient(t, true)
	req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{"title":"evil"}`))
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()
	c.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-site POST = %d, want 403", rec.Code)
	}
}

func TestCSVRoundTrip(t *testing.T) {
	c, store := newClient(t, true)
	var src db.Project
	c.do("POST", "/api/projects", map[string]any{"name": "Vacances d'été"}, 201, &src)
	var sec db.Section
	c.do("POST", "/api/sections", map[string]any{"project_id": src.ID, "name": "Preparations"}, 201, &sec)
	var root, sub db.Task
	c.do("POST", "/api/tasks", map[string]any{"title": "Buy tickets", "project_id": src.ID, "priority": 1,
		"due_date": "2026-11-05", "location": "Central Station, London", "description": "Window seat"}, 201, &root)
	c.do("POST", "/api/tasks", map[string]any{"title": "Compare prices", "parent_id": root.ID, "priority": 2}, 201, &sub)
	c.do("POST", "/api/tasks", map[string]any{"title": "Railcard", "parent_id": sub.ID}, 201, nil)
	c.do("POST", "/api/tasks", map[string]any{"title": "Water plants", "project_id": src.ID, "section_id": sec.ID,
		"due_date": "2026-11-01 08:30", "recurrence": "weekly:sunday"}, 201, nil)

	rec := c.do("GET", "/api/projects/"+src.ID+"/export", nil, 200, nil)
	exported := rec.Body.Bytes()
	if !strings.Contains(rec.Header().Get("Content-Disposition"), "filename*=UTF-8''Vacances") {
		t.Fatalf("Content-Disposition: %s", rec.Header().Get("Content-Disposition"))
	}

	var dst db.Project
	c.do("POST", "/api/projects", map[string]any{"name": "Copy"}, 201, &dst)
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	part, _ := mw.CreateFormFile("file", "export.csv")
	part.Write(exported)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/projects/"+dst.ID+"/import?today=2026-10-07", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	out := httptest.NewRecorder()
	c.handler.ServeHTTP(out, req)
	if out.Code != 200 || !strings.Contains(out.Body.String(), `"tasks_count":4`) {
		t.Fatalf("import = %d %s", out.Code, out.Body.String())
	}

	tasks, _ := store.ListTasks(db.TaskFilter{View: "project", ProjectID: dst.ID})
	if len(tasks) != 2 {
		t.Fatalf("imported roots = %d", len(tasks))
	}
	imported := tasks[0]
	if imported.Title != "Buy tickets" || imported.Priority != 1 || *imported.DueDate != "2026-11-05" ||
		*imported.Location != "Central Station, London" || imported.Description != "Window seat" {
		t.Fatalf("imported root: %+v", imported)
	}
	if imported.Subtasks[0].Title != "Compare prices" || imported.Subtasks[0].Subtasks[0].Title != "Railcard" {
		t.Fatal("hierarchy lost")
	}
	recurring := tasks[1]
	if recurring.SectionID == nil || *recurring.Recurrence != "weekly:sunday" || *recurring.DueDate != "2026-11-01 08:30" {
		t.Fatalf("recurring task: %+v", recurring)
	}
}

func TestCSVImportSemicolonAndBOM(t *testing.T) {
	c, store := newClient(t, true)
	var proj db.Project
	c.do("POST", "/api/projects", map[string]any{"name": "Excel"}, 201, &proj)
	data := "\xef\xbb\xbfTYPE;CONTENT;DESCRIPTION;PRIORITY;INDENT;AUTHOR;RESPONSIBLE;DATE;DATE_LANG;TIMEZONE\n" +
		"section;Section A;;;;;;;;\n" +
		"task;Task 1;Description 1;1;1;;;tomorrow;en;\n" +
		"task;Subtask 1.1;Location: 10 Downing Street, London;2;2;;;;;\n" +
		"note;A note for 1.1;;;;;;;;\n"
	req := httptest.NewRequest("POST", "/api/projects/"+proj.ID+"/import?today=2026-10-07", strings.NewReader(data))
	req.Header.Set("Content-Type", "text/csv")
	rec := httptest.NewRecorder()
	c.handler.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("import = %d %s", rec.Code, rec.Body.String())
	}
	tasks, _ := store.ListTasks(db.TaskFilter{View: "project", ProjectID: proj.ID})
	if len(tasks) != 1 || *tasks[0].DueDate != "2026-10-08" {
		t.Fatalf("tasks: %+v", tasks)
	}
	sub := tasks[0].Subtasks[0]
	if *sub.Location != "10 Downing Street, London" || sub.Description != "A note for 1.1" {
		t.Fatalf("subtask: %+v", sub)
	}
}
