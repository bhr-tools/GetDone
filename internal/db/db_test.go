package db_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ben/get-done/internal/db"
	"github.com/ben/get-done/internal/parser"
)

func setupTestDB(t *testing.T) (*db.Store, func()) {
	t.Helper()
	tmpDir, err := os.MkdirTemp("", "get_done_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	dbPath := filepath.Join(tmpDir, "test.db")
	store, err := db.NewStore(dbPath)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create store: %v", err)
	}

	cleanup := func() {
		store.Close()
		os.RemoveAll(tmpDir)
	}

	return store, cleanup
}

func TestInfiniteProjectHierarchy(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	// 1. Root project
	root := &db.Project{ID: "work", Name: "Travail"}
	if err := store.CreateProject(root); err != nil {
		t.Fatalf("Create root project failed: %v", err)
	}

	// 2. Sub project Level 1
	sub1Parent := "work"
	sub1 := &db.Project{ID: "clients", ParentID: &sub1Parent, Name: "Clients"}
	if err := store.CreateProject(sub1); err != nil {
		t.Fatalf("Create sub1 project failed: %v", err)
	}

	// 3. Sub project Level 2
	sub2Parent := "clients"
	sub2 := &db.Project{ID: "acme", ParentID: &sub2Parent, Name: "Acme Corp"}
	if err := store.CreateProject(sub2); err != nil {
		t.Fatalf("Create sub2 project failed: %v", err)
	}

	// List projects as tree
	projects, err := store.ListProjects()
	if err != nil {
		t.Fatalf("ListProjects failed: %v", err)
	}

	// Find "work" project
	var foundWork *db.Project
	for _, p := range projects {
		if p.ID == "work" {
			foundWork = p
			break
		}
	}

	if foundWork == nil {
		t.Fatalf("Work project not found in root list")
	}
	if len(foundWork.Children) != 1 || foundWork.Children[0].ID != "clients" {
		t.Fatalf("Expected 'clients' as child of 'work', got: %+v", foundWork.Children)
	}
	if len(foundWork.Children[0].Children) != 1 || foundWork.Children[0].Children[0].ID != "acme" {
		t.Fatalf("Expected 'acme' as grandchild of 'work', got: %+v", foundWork.Children[0].Children)
	}
}

func TestInfiniteTaskHierarchyAndCompletion(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	// 1. Create a parent task
	parent := &db.Task{
		ID:        "task-1",
		ProjectID: "inbox",
		Title:     "Préparer la release",
		Priority:  1,
	}
	if err := store.CreateTask(parent); err != nil {
		t.Fatalf("Create parent task failed: %v", err)
	}

	// 2. Create subtask level 1
	pID1 := "task-1"
	sub1 := &db.Task{
		ID:        "task-2",
		ProjectID: "inbox",
		ParentID:  &pID1,
		Title:     "Écrire la doc",
		Priority:  2,
	}
	if err := store.CreateTask(sub1); err != nil {
		t.Fatalf("Create subtask 1 failed: %v", err)
	}

	// 3. Create subtask level 2
	pID2 := "task-2"
	sub2 := &db.Task{
		ID:        "task-3",
		ProjectID: "inbox",
		ParentID:  &pID2,
		Title:     "Relire les raccourcis Vim",
		Priority:  3,
	}
	if err := store.CreateTask(sub2); err != nil {
		t.Fatalf("Create subtask 2 failed: %v", err)
	}

	// Check tree structure
	tasks, err := store.ListTasks(db.TaskFilter{View: "inbox"})
	if err != nil {
		t.Fatalf("ListTasks failed: %v", err)
	}

	if len(tasks) != 1 {
		t.Fatalf("Expected 1 root task, got %d", len(tasks))
	}
	if len(tasks[0].Subtasks) != 1 || tasks[0].Subtasks[0].ID != "task-2" {
		t.Fatalf("Expected task-2 as subtask of task-1")
	}
	if len(tasks[0].Subtasks[0].Subtasks) != 1 || tasks[0].Subtasks[0].Subtasks[0].ID != "task-3" {
		t.Fatalf("Expected task-3 as subtask of task-2")
	}

	// Test non-recurring task completion (should be deleted along with subtasks)
	_, deleted, err := store.CompleteTask("task-1", parser.NextDueDate, time.Now())
	if err != nil {
		t.Fatalf("CompleteTask failed: %v", err)
	}
	if !deleted {
		t.Errorf("Expected non-recurring task to be deleted")
	}

	tasksAfter, _ := store.ListTasks(db.TaskFilter{View: "inbox"})
	if len(tasksAfter) != 0 {
		t.Errorf("Expected 0 tasks after completion/deletion, got %d", len(tasksAfter))
	}
}

func TestRecurringTaskCompletion(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	dueDate := "2026-10-07"
	recurr := "daily"
	task := &db.Task{
		ID:         "rec-1",
		ProjectID:  "inbox",
		Title:      "Méditation quotidienne",
		DueDate:    &dueDate,
		Recurrence: &recurr,
	}
	if err := store.CreateTask(task); err != nil {
		t.Fatalf("Create recurring task failed: %v", err)
	}

	refTime := time.Date(2026, 10, 7, 10, 0, 0, 0, time.UTC)
	updated, deleted, err := store.CompleteTask("rec-1", parser.NextDueDate, refTime)
	if err != nil {
		t.Fatalf("CompleteTask recurring failed: %v", err)
	}
	if deleted {
		t.Errorf("Recurring task should NOT be deleted")
	}
	if updated == nil || updated.DueDate == nil || *updated.DueDate != "2026-10-08" {
		t.Errorf("Expected updated due date to be 2026-10-08, got %v", updated.DueDate)
	}
}

func TestRescueInboxAndListProjects(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	// 1. Create a project accidentally having parent_id = 'inbox'
	inboxStr := "inbox"
	p := &db.Project{
		ID:       "top-proj",
		Name:     "Top Project",
		ParentID: &inboxStr,
		Position: 0,
	}
	if err := store.CreateProject(p); err != nil {
		t.Fatalf("CreateProject failed: %v", err)
	}

	// 2. ListProjects should never return inbox and should rescue 'top-proj' as root
	projs, err := store.ListProjects()
	if err != nil {
		t.Fatalf("ListProjects failed: %v", err)
	}
	for _, proj := range projs {
		if proj.ID == "inbox" {
			t.Errorf("ListProjects must NOT return inbox")
		}
	}
	if len(projs) != 1 || projs[0].ID != "top-proj" {
		t.Fatalf("Expected top-proj to be root, got %+v", projs)
	}
	if projs[0].ParentID != nil {
		t.Errorf("Expected top-proj ParentID to be nil, got %v", *projs[0].ParentID)
	}

	// 3. ReorderProjects with parent_id = inbox should sanitize it to nil
	err = store.ReorderProjects([]db.ReorderProjectItem{
		{
			ID:       "top-proj",
			Position: 10,
			ParentID: &inboxStr,
		},
	})
	if err != nil {
		t.Fatalf("ReorderProjects failed: %v", err)
	}

	projsAfter, err := store.ListProjects()
	if err != nil {
		t.Fatalf("ListProjects after reorder failed: %v", err)
	}
	if len(projsAfter) != 1 || projsAfter[0].ParentID != nil {
		t.Errorf("Expected top-proj ParentID to be nil after ReorderProjects, got %+v", projsAfter)
	}
}

func TestTaskAppendOrdering(t *testing.T) {
	dir, err := os.MkdirTemp("", "get-done-pos-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)

	store, err := db.NewStore(filepath.Join(dir, "tasks.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	// 1. Create a root task
	root := &db.Task{ID: "root-1", ProjectID: "inbox", Title: "Root"}
	if err := store.CreateTask(root); err != nil {
		t.Fatal(err)
	}

	// 2. Create subtasks without explicit position
	pID := "root-1"
	sub1 := &db.Task{ID: "sub-1", ProjectID: "inbox", ParentID: &pID, Title: "Sub 1"}
	if err := store.CreateTask(sub1); err != nil {
		t.Fatal(err)
	}
	sub2 := &db.Task{ID: "sub-2", ProjectID: "inbox", ParentID: &pID, Title: "Sub 2"}
	if err := store.CreateTask(sub2); err != nil {
		t.Fatal(err)
	}

	rootTask, err := store.GetTask("root-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rootTask.Subtasks) != 2 {
		t.Fatalf("Expected 2 subtasks, got %d", len(rootTask.Subtasks))
	}
	if rootTask.Subtasks[0].ID != "sub-1" || rootTask.Subtasks[1].ID != "sub-2" {
		t.Fatalf("Expected sub-1 followed by sub-2, got %s then %s", rootTask.Subtasks[0].ID, rootTask.Subtasks[1].ID)
	}
	if rootTask.Subtasks[1].Position <= rootTask.Subtasks[0].Position {
		t.Errorf("Expected sub-2 position (%d) > sub-1 position (%d)", rootTask.Subtasks[1].Position, rootTask.Subtasks[0].Position)
	}
}

func TestSectionCascadeDelete(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	proj := &db.Project{Name: "Cascade Project"}
	if err := store.CreateProject(proj); err != nil {
		t.Fatalf("CreateProject failed: %v", err)
	}

	sec := &db.Section{ProjectID: proj.ID, Name: "Sprint 1"}
	if err := store.CreateSection(sec); err != nil {
		t.Fatalf("CreateSection failed: %v", err)
	}

	task1 := &db.Task{ProjectID: proj.ID, SectionID: &sec.ID, Title: "Task in Section 1"}
	task2 := &db.Task{ProjectID: proj.ID, SectionID: &sec.ID, Title: "Task in Section 2"}
	if err := store.CreateTask(task1); err != nil {
		t.Fatalf("CreateTask 1 failed: %v", err)
	}
	if err := store.CreateTask(task2); err != nil {
		t.Fatalf("CreateTask 2 failed: %v", err)
	}

	// Delete section
	if err := store.DeleteSection(sec.ID); err != nil {
		t.Fatalf("DeleteSection failed: %v", err)
	}

	// Verify section is gone
	sections, err := store.ListSections(proj.ID)
	if err != nil {
		t.Fatalf("ListSections failed: %v", err)
	}
	if len(sections) != 0 {
		t.Errorf("Expected 0 sections, got %d", len(sections))
	}

	// Verify tasks in section are permanently deleted
	t1, err := store.GetTask(task1.ID)
	if err == nil && t1 != nil {
		t.Errorf("Expected task1 to be deleted, but still found: %+v", t1)
	}
	t2, err := store.GetTask(task2.ID)
	if err == nil && t2 != nil {
		t.Errorf("Expected task2 to be deleted, but still found: %+v", t2)
	}
}

func TestSectionPositionDefault(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	proj := &db.Project{Name: "Position Project"}
	if err := store.CreateProject(proj); err != nil {
		t.Fatalf("CreateProject failed: %v", err)
	}

	sec1 := &db.Section{ProjectID: proj.ID, Name: "First Section"}
	if err := store.CreateSection(sec1); err != nil {
		t.Fatalf("CreateSection 1 failed: %v", err)
	}
	sec2 := &db.Section{ProjectID: proj.ID, Name: "Second Section"}
	if err := store.CreateSection(sec2); err != nil {
		t.Fatalf("CreateSection 2 failed: %v", err)
	}
	sec3 := &db.Section{ProjectID: proj.ID, Name: "Third Section"}
	if err := store.CreateSection(sec3); err != nil {
		t.Fatalf("CreateSection 3 failed: %v", err)
	}

	sections, err := store.ListSections(proj.ID)
	if err != nil {
		t.Fatalf("ListSections failed: %v", err)
	}
	if len(sections) != 3 {
		t.Fatalf("Expected 3 sections, got %d", len(sections))
	}

	if sections[0].Position >= sections[1].Position || sections[1].Position >= sections[2].Position {
		t.Errorf("Expected strictly increasing section positions: %d, %d, %d",
			sections[0].Position, sections[1].Position, sections[2].Position)
	}
}

func TestProjectSortPersistence(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	// 1. Inbox default sort
	inbox, err := store.GetProject("inbox")
	if err != nil {
		t.Fatalf("GetProject inbox failed: %v", err)
	}
	if inbox.SortBy != "manual" || inbox.SortOrder != "asc" {
		t.Errorf("Expected inbox default sort to be manual/asc, got %s/%s", inbox.SortBy, inbox.SortOrder)
	}

	// 2. Update inbox sort
	if err := store.UpdateProjectSort("inbox", "priority", "desc"); err != nil {
		t.Fatalf("UpdateProjectSort inbox failed: %v", err)
	}
	inboxUpdated, err := store.GetProject("inbox")
	if err != nil {
		t.Fatalf("GetProject inbox failed: %v", err)
	}
	if inboxUpdated.SortBy != "priority" || inboxUpdated.SortOrder != "desc" {
		t.Errorf("Expected inbox updated sort to be priority/desc, got %s/%s", inboxUpdated.SortBy, inboxUpdated.SortOrder)
	}

	// 3. Custom project
	proj := &db.Project{Name: "Sortable Project"}
	if err := store.CreateProject(proj); err != nil {
		t.Fatalf("CreateProject failed: %v", err)
	}
	if err := store.UpdateProjectSort(proj.ID, "date", "asc"); err != nil {
		t.Fatalf("UpdateProjectSort proj failed: %v", err)
	}
	p, err := store.GetProject(proj.ID)
	if err != nil {
		t.Fatalf("GetProject failed: %v", err)
	}
	if p.SortBy != "date" || p.SortOrder != "asc" {
		t.Errorf("Expected date/asc sort, got %s/%s", p.SortBy, p.SortOrder)
	}
}

