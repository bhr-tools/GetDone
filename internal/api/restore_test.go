package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ben/get-done/internal/db"
)

func TestTaskCompleteAndRestore(t *testing.T) {
	api, store := setupTestAPI(t)
	defer store.Close()

	// 1. Create a project and tasks
	proj := &db.Project{Name: "Undo Test"}
	if err := store.CreateProject(proj); err != nil {
		t.Fatalf("failed to create project: %v", err)
	}

	due := "2026-10-15"
	tParent := &db.Task{
		ProjectID: proj.ID,
		Title:     "Parent to delete",
		Priority:  1,
		DueDate:   &due,
	}
	if err := store.CreateTask(tParent); err != nil {
		t.Fatalf("failed to create parent task: %v", err)
	}

	tChild := &db.Task{
		ProjectID: proj.ID,
		ParentID:  &tParent.ID,
		Title:     "Child task",
		Priority:  2,
	}
	if err := store.CreateTask(tChild); err != nil {
		t.Fatalf("failed to create child task: %v", err)
	}

	// 2. Complete parent task (should cascade delete child)
	reqComplete := httptest.NewRequest(http.MethodPost, "/api/tasks/"+tParent.ID+"/complete", nil)
	wComplete := httptest.NewRecorder()
	api.handleTaskItem(wComplete, reqComplete)

	if wComplete.Code != http.StatusOK {
		t.Fatalf("complete failed: %d %s", wComplete.Code, wComplete.Body.String())
	}

	var completeResp struct {
		Deleted bool     `json:"deleted"`
		Task    *db.Task `json:"task"`
	}
	if err := json.Unmarshal(wComplete.Body.Bytes(), &completeResp); err != nil {
		t.Fatalf("failed to parse complete response: %v", err)
	}

	if !completeResp.Deleted {
		t.Fatalf("expected deleted=true")
	}
	if completeResp.Task == nil || completeResp.Task.Title != "Parent to delete" {
		t.Fatalf("expected deleted task snapshot returned, got %v", completeResp.Task)
	}

	// Verify tasks are gone from DB
	tasksAfterDelete, _ := store.ListProjectTasksForExport(proj.ID)
	if len(tasksAfterDelete) != 0 {
		t.Fatalf("expected 0 tasks after delete, got %d", len(tasksAfterDelete))
	}

	// 3. Restore parent task and its child via /api/tasks/restore
	// Ensure completeResp.Task has subtasks attached for restoration
	completeResp.Task.Subtasks = []*db.Task{tChild}

	restorePayload := map[string]interface{}{
		"tasks": []*db.Task{completeResp.Task},
	}
	bodyBytes, _ := json.Marshal(restorePayload)

	reqRestore := httptest.NewRequest(http.MethodPost, "/api/tasks/restore", bytes.NewReader(bodyBytes))
	reqRestore.Header.Set("Content-Type", "application/json")
	wRestore := httptest.NewRecorder()
	api.handleTasksRestore(wRestore, reqRestore)

	if wRestore.Code != http.StatusOK {
		t.Fatalf("restore failed: %d %s", wRestore.Code, wRestore.Body.String())
	}

	// 4. Verify tasks are back
	tasksRestored, err := store.ListProjectTasksForExport(proj.ID)
	if err != nil {
		t.Fatalf("failed to list tasks: %v", err)
	}
	if len(tasksRestored) != 2 {
		t.Fatalf("expected 2 tasks restored, got %d", len(tasksRestored))
	}

	// Verify hierarchy preserved
	var foundParent, foundChild *db.Task
	for _, tsk := range tasksRestored {
		if tsk.ID == tParent.ID {
			foundParent = tsk
		}
		if tsk.ID == tChild.ID {
			foundChild = tsk
		}
	}

	if foundParent == nil || foundChild == nil {
		t.Fatalf("expected both parent and child restored")
	}
	if foundChild.ParentID == nil || *foundChild.ParentID != foundParent.ID {
		t.Fatalf("expected child to be linked to parent: %v", foundChild)
	}
}
