package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

type syncAnswer struct {
	Results []syncResult `json:"results"`
	ETag    string       `json:"etag"`
	// Raw lists, to look at null and values.
	Snapshot struct {
		Projects []map[string]any `json:"projects"`
		Sections []map[string]any `json:"sections"`
		Tasks    []map[string]any `json:"tasks"`
	} `json:"snapshot"`
}

func op(id, typ string, args any) map[string]any {
	return map[string]any{"id": id, "type": typ, "args": args}
}

func (c *client) sync(ops ...map[string]any) syncAnswer {
	c.t.Helper()
	var out syncAnswer
	c.do("POST", "/api/sync", map[string]any{"ops": ops}, 200, &out)
	return out
}

func findByID(list []map[string]any, id string) map[string]any {
	for _, m := range list {
		if m["id"] == id {
			return m
		}
	}
	return nil
}

func TestSyncSnapshot(t *testing.T) {
	c, _ := newClient(t, true)
	var first syncAnswer
	rec := c.do("GET", "/api/sync", nil, 200, &first)
	if rec.Header().Get("ETag") != first.ETag || first.ETag == "" {
		t.Fatalf("ETag header %q, body %q", rec.Header().Get("ETag"), first.ETag)
	}
	if findByID(first.Snapshot.Projects, "inbox") == nil {
		t.Fatal("snapshot has no inbox")
	}
	var raw struct {
		Snapshot map[string]json.RawMessage `json:"snapshot"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"projects", "sections", "tasks"} {
		if string(raw.Snapshot[k]) == "null" || raw.Snapshot[k][0] != '[' {
			t.Fatalf("%s = %s, want an array", k, raw.Snapshot[k])
		}
	}

	req := httptest.NewRequest("GET", "/api/sync", nil)
	req.Header.Set("If-None-Match", first.ETag)
	rr := httptest.NewRecorder()
	c.handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match: status %d, want 304", rr.Code)
	}

	c.do("POST", "/api/tasks", map[string]any{"title": "x", "project_id": "inbox"}, 201, nil)
	var second syncAnswer
	c.do("GET", "/api/sync", nil, 200, &second)
	if second.ETag == first.ETag {
		t.Fatal("ETag did not change after a new task")
	}
}

func TestSyncAppliesInOrderOnce(t *testing.T) {
	c, _ := newClient(t, true)
	p, s, tk := uuid.NewString(), uuid.NewString(), uuid.NewString()
	ops := []map[string]any{
		op(uuid.NewString(), "project.create", map[string]any{"id": p, "name": "P"}),
		op(uuid.NewString(), "section.create", map[string]any{"id": s, "project_id": p, "name": "S"}),
		op(uuid.NewString(), "task.create", map[string]any{
			"id": tk, "project_id": p, "section_id": s, "title": "T",
			"recurrence": "daily", "due_date": "2026-01-10",
		}),
		op(uuid.NewString(), "task.update", map[string]any{"id": tk, "fields": map[string]any{"title": "Renamed"}}),
		op(uuid.NewString(), "task.complete", map[string]any{"id": tk, "today": "2026-01-05", "due_date": "2026-01-10"}),
	}
	check := func(out syncAnswer) {
		t.Helper()
		for _, r := range out.Results {
			if r.Status != "ok" {
				t.Fatalf("result %+v", r)
			}
		}
		n := 0
		for _, pr := range out.Snapshot.Projects {
			if pr["name"] == "P" {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("%d projects named P", n)
		}
		task := findByID(out.Snapshot.Tasks, tk)
		if task == nil {
			t.Fatal("task with the client id not found")
		}
		if task["title"] != "Renamed" || task["due_date"] != "2026-01-11" {
			t.Fatalf("task = %v", task)
		}
	}
	check(c.sync(ops...))
	check(c.sync(ops...))
}

func TestSyncStatuses(t *testing.T) {
	c, _ := newClient(t, true)
	good := uuid.NewString()
	out := c.sync(
		op(uuid.NewString(), "task.update", map[string]any{"id": uuid.NewString(), "fields": map[string]any{"title": "x"}}),
		op(uuid.NewString(), "task.create", map[string]any{"project_id": "inbox", "title": " "}),
		op("nope", "task.create", map[string]any{"project_id": "inbox", "title": "x"}),
		op(uuid.NewString(), "task.fly", map[string]any{}),
		op(uuid.NewString(), "task.create", map[string]any{"project_id": "inbox", "title": 42}),
		op(good, "task.create", map[string]any{"id": good, "project_id": "inbox", "title": "ok"}),
	)
	want := []string{"not_found", "invalid", "invalid", "invalid", "invalid", "ok"}
	for i, w := range want {
		if out.Results[i].Status != w {
			t.Errorf("result %d = %+v, want %s", i, out.Results[i], w)
		}
	}
	if out.Results[1].Error == "" || out.Results[3].Error == "" {
		t.Errorf("missing error messages: %+v", out.Results)
	}
	if findByID(out.Snapshot.Tasks, good) == nil {
		t.Error("valid task missing from the snapshot")
	}
}

func TestSyncCompleteStaleDue(t *testing.T) {
	c, _ := newClient(t, true)
	tk := uuid.NewString()
	out := c.sync(
		op(uuid.NewString(), "task.create", map[string]any{
			"id": tk, "project_id": "inbox", "title": "T", "recurrence": "daily", "due_date": "2026-01-10",
		}),
		op(uuid.NewString(), "task.complete", map[string]any{"id": tk, "today": "2026-01-05", "due_date": "2026-01-09"}),
	)
	if out.Results[1].Status != "ok" {
		t.Fatalf("result %+v", out.Results[1])
	}
	if got := findByID(out.Snapshot.Tasks, tk)["due_date"]; got != "2026-01-10" {
		t.Fatalf("due_date = %v, want unchanged", got)
	}
}

func TestSyncClientIDValidation(t *testing.T) {
	c, _ := newClient(t, true)
	out := c.sync(op(uuid.NewString(), "task.create", map[string]any{"id": "x", "project_id": "inbox", "title": "T"}))
	if r := out.Results[0]; r.Status != "invalid" || r.Error != "invalid id" {
		t.Fatalf("result %+v", r)
	}
}

func TestSyncTooManyOps(t *testing.T) {
	c, _ := newClient(t, true)
	ops := make([]map[string]any, maxSyncOps+1)
	for i := range ops {
		ops[i] = op(uuid.NewString(), "task.delete", map[string]any{"id": "x"})
	}
	c.do("POST", "/api/sync", map[string]any{"ops": ops}, 400, nil)
}
