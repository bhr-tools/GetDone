package api

// Offline sync: the kit (kit/offline) serves /api/sync and applies each change
// once; this file gives it GetDone's snapshot and how to apply one change.

import (
	"fmt"

	"github.com/bhr-tools/getdone/internal/db"
	"github.com/bhr-tools/getdone/internal/parser"
	"github.com/bhr-tools/kit/offline"
)

// snapshot is all the data, with signed links to the attachments.
func (a *API) snapshot() (any, error) {
	snap, err := a.store.Snapshot()
	if err != nil {
		return nil, err
	}
	for i := range snap.Attachments {
		snap.Attachments[i].URL = a.fileLink(snap.Attachments[i].ID)
	}
	return snap, nil
}

// args decodes the arguments of a change; a malformed change is invalid.
func args(op offline.Op, dst any) error {
	return op.Decode(dst)
}

// sameDue reports whether two optional due dates are equal.
func sameDue(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// dispatch applies one change with the matching store method.
func (a *API) dispatch(op offline.Op) error {
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
