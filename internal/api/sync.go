package api

// Offline sync (see the offline plan): GET /api/sync returns all the data;
// POST /api/sync applies changes made offline, in order, then returns the new
// data. Each change has a client-chosen UUID, recorded once applied, so a
// batch sent twice (lost answer, retry) is applied once.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/google/uuid"

	"github.com/ben/get-done/internal/db"
	"github.com/ben/get-done/internal/parser"
)

const maxSyncOps = 500

type syncOp struct {
	ID   string          `json:"id"`
	Type string          `json:"type"`
	Args json.RawMessage `json:"args"`
}

type syncResult struct {
	ID     string `json:"id"`
	Status string `json:"status"` // ok | not_found | invalid
	Error  string `json:"error,omitempty"`
}

type syncResponse struct {
	Results  []syncResult    `json:"results,omitempty"`
	ETag     string          `json:"etag"`
	Snapshot json.RawMessage `json:"snapshot"`
}

// snapshot returns the encoded snapshot and its ETag.
func (a *API) snapshot() (json.RawMessage, string, error) {
	snap, err := a.store.Snapshot()
	if err != nil {
		return nil, "", err
	}
	body, err := json.Marshal(snap)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(body)
	return body, `"` + hex.EncodeToString(sum[:16]) + `"`, nil
}

func (a *API) getSync(w http.ResponseWriter, r *http.Request) {
	body, etag, err := a.snapshot()
	if err != nil {
		fail(w, r, err)
		return
	}
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, syncResponse{ETag: etag, Snapshot: body})
}

func (a *API) postSync(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Ops []syncOp `json:"ops"`
	}
	if !decode(w, r, &req) {
		return
	}
	if len(req.Ops) > maxSyncOps {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Too many changes at once (max %d)", maxSyncOps))
		return
	}
	results := make([]syncResult, 0, len(req.Ops))
	for _, op := range req.Ops {
		res, err := a.applySyncOp(op)
		if err != nil {
			fail(w, r, err) // the client sends the batch again; applied changes are skipped
			return
		}
		results = append(results, res)
	}
	if err := a.store.PruneSyncOps(); err != nil {
		log.Printf("prune sync ops: %v", err)
	}
	body, etag, err := a.snapshot()
	if err != nil {
		fail(w, r, err)
		return
	}
	w.Header().Set("ETag", etag)
	writeJSON(w, http.StatusOK, syncResponse{Results: results, ETag: etag, Snapshot: body})
}

// applySyncOp applies one change once. Only internal errors are returned.
func (a *API) applySyncOp(op syncOp) (syncResult, error) {
	res := syncResult{ID: op.ID, Status: "ok"}
	if _, err := uuid.Parse(op.ID); err != nil {
		res.Status, res.Error = "invalid", "Invalid operation id"
		return res, nil
	}
	status, msg, found, err := a.store.SyncOpStatus(op.ID)
	if err != nil {
		return res, err
	}
	if found {
		res.Status, res.Error = status, msg
		return res, nil
	}
	var invalidErr *db.ValidationError
	switch err := a.dispatch(op); {
	case err == nil:
	case errors.Is(err, db.ErrNotFound):
		res.Status = "not_found"
	case errors.As(err, &invalidErr):
		res.Status, res.Error = "invalid", invalidErr.Msg
	default:
		return res, err
	}
	return res, a.store.RecordSyncOp(op.ID, res.Status, res.Error)
}

// args decodes the arguments of a change; a malformed change is invalid.
func args(op syncOp, dst any) error {
	if err := json.Unmarshal(op.Args, dst); err != nil {
		return &db.ValidationError{Msg: "Invalid arguments: " + err.Error()}
	}
	return nil
}

// sameDue reports whether two optional due dates are equal.
func sameDue(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// dispatch applies one change with the matching store method.
func (a *API) dispatch(op syncOp) error {
	s := a.store
	switch op.Type {
	case "project.create":
		var x struct {
			ID       string  `json:"id"`
			Name     string  `json:"name"`
			ParentID *string `json:"parent_id"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		if x.ID != "" {
			if _, err := s.GetProject(x.ID); err == nil {
				return nil
			}
		}
		_, err := s.CreateProject(x.ID, x.Name, x.ParentID)
		return err
	case "project.rename":
		var x struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		_, err := s.RenameProject(x.ID, x.Name)
		return err
	case "project.delete":
		var x struct {
			ID string `json:"id"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		return s.DeleteProject(x.ID)
	case "project.move":
		var x struct {
			ID       string  `json:"id"`
			ParentID *string `json:"parent_id"`
			db.Placement
		}
		if err := args(op, &x); err != nil {
			return err
		}
		return s.MoveProject(x.ID, x.ParentID, x.Placement)
	case "project.sort":
		var x struct {
			ID     string `json:"id"`
			SortBy string `json:"sort_by"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		return s.SetProjectSort(x.ID, x.SortBy)
	case "section.create":
		var x struct {
			ID        string `json:"id"`
			ProjectID string `json:"project_id"`
			Name      string `json:"name"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		if x.ID != "" {
			if _, err := s.GetSection(x.ID); err == nil {
				return nil
			}
		}
		_, err := s.CreateSection(x.ID, x.ProjectID, x.Name)
		return err
	case "section.rename":
		var x struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		_, err := s.RenameSection(x.ID, x.Name)
		return err
	case "section.delete":
		var x struct {
			ID string `json:"id"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		return s.DeleteSection(x.ID)
	case "section.move":
		var x struct {
			ID        string `json:"id"`
			ProjectID string `json:"project_id"`
			db.Placement
		}
		if err := args(op, &x); err != nil {
			return err
		}
		return s.MoveSection(x.ID, x.ProjectID, x.Placement)
	case "task.create":
		var in db.NewTask
		if err := args(op, &in); err != nil {
			return err
		}
		if in.ID != "" {
			if _, err := s.GetTask(in.ID); err == nil {
				return nil
			}
		}
		_, err := s.CreateTask(in)
		return err
	case "task.update":
		var x struct {
			ID     string       `json:"id"`
			Fields db.TaskPatch `json:"fields"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		_, err := s.UpdateTask(x.ID, x.Fields)
		return err
	case "task.move":
		var x struct {
			ID string `json:"id"`
			db.TaskMove
		}
		if err := args(op, &x); err != nil {
			return err
		}
		_, err := s.MoveTask(x.ID, x.TaskMove)
		return err
	case "task.delete":
		var x struct {
			ID string `json:"id"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		return s.DeleteTask(x.ID)
	case "task.complete":
		var x struct {
			ID      string  `json:"id"`
			Today   string  `json:"today"`
			DueDate *string `json:"due_date"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		t, err := s.GetTask(x.ID)
		if err != nil {
			return err
		}
		// A recurring task whose date moved since the client saw it was
		// completed already (or rescheduled elsewhere): don't skip another
		// occurrence.
		if t.Recurrence != nil && !sameDue(t.DueDate, x.DueDate) {
			return nil
		}
		_, err = s.CompleteTask(x.ID, parser.NormalizeToday(x.Today))
		return err
	case "task.restore":
		var x struct {
			Tasks   []*db.Task         `json:"tasks"`
			Updates []db.RestoreUpdate `json:"updates"`
		}
		if err := args(op, &x); err != nil {
			return err
		}
		return s.RestoreTasks(x.Tasks, x.Updates)
	}
	return &db.ValidationError{Msg: fmt.Sprintf("Unknown operation %q", op.Type)}
}
