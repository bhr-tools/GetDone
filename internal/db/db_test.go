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

func TestPatchTaskProjectAndSectionCascade(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	p1 := &db.Project{ID: "p1", Name: "Project 1"}
	p2 := &db.Project{ID: "p2", Name: "Project 2"}
	_ = store.CreateProject(p1)
	_ = store.CreateProject(p2)

	sec1 := &db.Section{ID: "s1", ProjectID: "p1", Name: "Section 1"}
	sec2 := &db.Section{ID: "s2", ProjectID: "p2", Name: "Section 2"}
	_ = store.CreateSection(sec1)
	_ = store.CreateSection(sec2)

	s1ID := "s1"
	parent := &db.Task{ID: "parent", ProjectID: "p1", SectionID: &s1ID, Title: "Parent", Position: 1}
	_ = store.CreateTask(parent)

	pID := "parent"
	c1 := &db.Task{ID: "c1", ProjectID: "p1", SectionID: &s1ID, ParentID: &pID, Title: "Child 1", Position: 1}
	c2 := &db.Task{ID: "c2", ProjectID: "p1", SectionID: &s1ID, ParentID: &pID, Title: "Child 2", Position: 2}
	_ = store.CreateTask(c1)
	_ = store.CreateTask(c2)

	c1ID := "c1"
	grandchild := &db.Task{ID: "g1", ProjectID: "p1", SectionID: &s1ID, ParentID: &c1ID, Title: "Grandchild", Position: 1}
	_ = store.CreateTask(grandchild)

	// 1. Relocate to p2 and s2
	_, err := store.PatchTask("parent", map[string]interface{}{
		"project_id": "p2",
		"section_id": "s2",
	})
	if err != nil {
		t.Fatalf("PatchTask failed: %v", err)
	}

	for _, id := range []string{"parent", "c1", "c2", "g1"} {
		task, err := store.GetTask(id)
		if err != nil {
			t.Fatalf("GetTask %s failed: %v", id, err)
		}
		if task.ProjectID != "p2" {
			t.Errorf("Task %s: expected project_id 'p2', got %s", id, task.ProjectID)
		}
		if task.SectionID == nil || *task.SectionID != "s2" {
			t.Errorf("Task %s: expected section_id 's2', got %v", id, task.SectionID)
		}
	}

	// Verify hierarchy and positions
	c1Task, _ := store.GetTask("c1")
	c2Task, _ := store.GetTask("c2")
	g1Task, _ := store.GetTask("g1")
	if *c1Task.ParentID != "parent" || *c2Task.ParentID != "parent" {
		t.Errorf("Expected c1 and c2 parent_id to be 'parent'")
	}
	if *g1Task.ParentID != "c1" {
		t.Errorf("Expected g1 parent_id to be 'c1'")
	}
	if c1Task.Position >= c2Task.Position {
		t.Errorf("Expected c1 position (%d) < c2 position (%d)", c1Task.Position, c2Task.Position)
	}

	// 2. Clear section (section_id = nil)
	_, err = store.PatchTask("parent", map[string]interface{}{
		"section_id": nil,
	})
	if err != nil {
		t.Fatalf("PatchTask clearing section failed: %v", err)
	}

	for _, id := range []string{"parent", "c1", "c2", "g1"} {
		task, err := store.GetTask(id)
		if err != nil {
			t.Fatalf("GetTask %s failed: %v", id, err)
		}
		if task.SectionID != nil {
			t.Errorf("Task %s: expected nil section_id, got %v", id, *task.SectionID)
		}
		if task.ProjectID != "p2" {
			t.Errorf("Task %s: expected project_id 'p2', got %s", id, task.ProjectID)
		}
	}
}

func TestReorderTasksCascade(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	p1 := &db.Project{ID: "p1", Name: "Project 1"}
	p2 := &db.Project{ID: "p2", Name: "Project 2"}
	_ = store.CreateProject(p1)
	_ = store.CreateProject(p2)

	sec1 := &db.Section{ID: "s1", ProjectID: "p1", Name: "Section 1"}
	sec2 := &db.Section{ID: "s2", ProjectID: "p2", Name: "Section 2"}
	_ = store.CreateSection(sec1)
	_ = store.CreateSection(sec2)

	s1ID := "s1"
	parent := &db.Task{ID: "parent", ProjectID: "p1", SectionID: &s1ID, Title: "Parent", Position: 1}
	_ = store.CreateTask(parent)

	pID := "parent"
	c1 := &db.Task{ID: "c1", ProjectID: "p1", SectionID: &s1ID, ParentID: &pID, Title: "Child 1", Position: 1}
	c2 := &db.Task{ID: "c2", ProjectID: "p1", SectionID: &s1ID, ParentID: &pID, Title: "Child 2", Position: 2}
	_ = store.CreateTask(c1)
	_ = store.CreateTask(c2)

	c1ID := "c1"
	grandchild := &db.Task{ID: "g1", ProjectID: "p1", SectionID: &s1ID, ParentID: &c1ID, Title: "Grandchild", Position: 1}
	_ = store.CreateTask(grandchild)

	// ReorderTasks: Move parent to p2, s2
	p2ID := "p2"
	s2ID := "s2"
	err := store.ReorderTasks([]db.ReorderTaskItem{
		{
			ID:        "parent",
			Position:  5,
			ParentID:  nil,
			SectionID: &s2ID,
			ProjectID: &p2ID,
		},
	})
	if err != nil {
		t.Fatalf("ReorderTasks failed: %v", err)
	}

	for _, id := range []string{"parent", "c1", "c2", "g1"} {
		task, err := store.GetTask(id)
		if err != nil {
			t.Fatalf("GetTask %s failed: %v", id, err)
		}
		if task.ProjectID != "p2" {
			t.Errorf("Task %s: expected project_id 'p2', got %s", id, task.ProjectID)
		}
		if task.SectionID == nil || *task.SectionID != "s2" {
			t.Errorf("Task %s: expected section_id 's2', got %v", id, task.SectionID)
		}
	}

	// ReorderTasks with subtasks passed along with stale section/project
	err = store.ReorderTasks([]db.ReorderTaskItem{
		{
			ID:        "parent",
			Position:  1,
			ParentID:  nil,
			SectionID: &s1ID,
			ProjectID: &p1.ID,
		},
		{
			ID:        "c2",
			Position:  10,
			ParentID:  &pID,
			SectionID: &s2ID, // stale
			ProjectID: &p2ID, // stale
		},
		{
			ID:        "c1",
			Position:  20,
			ParentID:  &pID,
			SectionID: &s2ID, // stale
			ProjectID: &p2ID, // stale
		},
	})
	if err != nil {
		t.Fatalf("ReorderTasks with subtasks failed: %v", err)
	}

	for _, id := range []string{"parent", "c1", "c2", "g1"} {
		task, err := store.GetTask(id)
		if err != nil {
			t.Fatalf("GetTask %s failed: %v", id, err)
		}
		if task.ProjectID != "p1" {
			t.Errorf("Task %s: expected project_id 'p1', got %s", id, task.ProjectID)
		}
		if task.SectionID == nil || *task.SectionID != "s1" {
			t.Errorf("Task %s: expected section_id 's1', got %v", id, task.SectionID)
		}
	}

	c1Task, _ := store.GetTask("c1")
	c2Task, _ := store.GetTask("c2")
	if c2Task.Position != 10 || c1Task.Position != 20 {
		t.Errorf("Expected c2 position 10 and c1 position 20, got %d and %d", c2Task.Position, c1Task.Position)
	}
}

func TestPostponeTaskCascade(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	parentDue := "2026-10-20"
	parent := &db.Task{ID: "p", ProjectID: "inbox", Title: "Parent", DueDate: &parentDue}
	_ = store.CreateTask(parent)

	pID := "p"
	c1Due := "2026-10-22 14:30"
	c1 := &db.Task{ID: "c1", ProjectID: "inbox", ParentID: &pID, Title: "Child 1", DueDate: &c1Due}
	c2 := &db.Task{ID: "c2", ProjectID: "inbox", ParentID: &pID, Title: "Child 2"} // no due date
	_ = store.CreateTask(c1)
	_ = store.CreateTask(c2)

	c1ID := "c1"
	gDue := "2026-10-25 09:00"
	grandchild := &db.Task{ID: "g", ProjectID: "inbox", ParentID: &c1ID, Title: "Grandchild", DueDate: &gDue}
	_ = store.CreateTask(grandchild)

	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	if err := store.PostponeTask("p", 3, now); err != nil {
		t.Fatalf("PostponeTask failed: %v", err)
	}

	pTask, _ := store.GetTask("p")
	if pTask.DueDate == nil || *pTask.DueDate != "2026-10-23" {
		t.Errorf("Expected parent due date 2026-10-23, got %v", pTask.DueDate)
	}

	c1Task, _ := store.GetTask("c1")
	if c1Task.DueDate == nil || *c1Task.DueDate != "2026-10-25 14:30" {
		t.Errorf("Expected c1 due date 2026-10-25 14:30, got %v", c1Task.DueDate)
	}

	c2Task, _ := store.GetTask("c2")
	if c2Task.DueDate != nil {
		t.Errorf("Expected c2 due date to remain nil, got %v", *c2Task.DueDate)
	}

	gTask, _ := store.GetTask("g")
	if gTask.DueDate == nil || *gTask.DueDate != "2026-10-28 09:00" {
		t.Errorf("Expected grandchild due date 2026-10-28 09:00, got %v", gTask.DueDate)
	}
}

func TestPatchTaskDueDateCascade(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	parentDue := "2026-10-20 10:00"
	parent := &db.Task{ID: "p", ProjectID: "inbox", Title: "Parent", DueDate: &parentDue}
	_ = store.CreateTask(parent)

	pID := "p"
	c1Due := "2026-10-22 15:00"
	c2Due := "2026-10-24"
	c1 := &db.Task{ID: "c1", ProjectID: "inbox", ParentID: &pID, Title: "Child 1", DueDate: &c1Due}
	c2 := &db.Task{ID: "c2", ProjectID: "inbox", ParentID: &pID, Title: "Child 2", DueDate: &c2Due}
	c3 := &db.Task{ID: "c3", ProjectID: "inbox", ParentID: &pID, Title: "Child 3"} // no due date
	_ = store.CreateTask(c1)
	_ = store.CreateTask(c2)
	_ = store.CreateTask(c3)

	c1ID := "c1"
	gDue := "2026-10-25 18:45"
	grandchild := &db.Task{ID: "g", ProjectID: "inbox", ParentID: &c1ID, Title: "Grandchild", DueDate: &gDue}
	_ = store.CreateTask(grandchild)

	// 1. Shift forward by +5 days (2026-10-20 -> 2026-10-25)
	_, err := store.PatchTask("p", map[string]interface{}{
		"due_date": "2026-10-25 12:00",
	})
	if err != nil {
		t.Fatalf("PatchTask forward failed: %v", err)
	}

	pTask, _ := store.GetTask("p")
	if pTask.DueDate == nil || *pTask.DueDate != "2026-10-25 12:00" {
		t.Errorf("Expected parent due date 2026-10-25 12:00, got %v", pTask.DueDate)
	}

	c1Task, _ := store.GetTask("c1")
	if c1Task.DueDate == nil || *c1Task.DueDate != "2026-10-27 15:00" {
		t.Errorf("Expected c1 due date 2026-10-27 15:00, got %v", c1Task.DueDate)
	}

	c2Task, _ := store.GetTask("c2")
	if c2Task.DueDate == nil || *c2Task.DueDate != "2026-10-29" {
		t.Errorf("Expected c2 due date 2026-10-29, got %v", c2Task.DueDate)
	}

	c3Task, _ := store.GetTask("c3")
	if c3Task.DueDate != nil {
		t.Errorf("Expected c3 due date to remain nil, got %v", *c3Task.DueDate)
	}

	gTask, _ := store.GetTask("g")
	if gTask.DueDate == nil || *gTask.DueDate != "2026-10-30 18:45" {
		t.Errorf("Expected g due date 2026-10-30 18:45, got %v", gTask.DueDate)
	}

	// 2. Shift backward by -3 days (2026-10-25 -> 2026-10-22)
	_, err = store.PatchTask("p", map[string]interface{}{
		"due_date": "2026-10-22 08:00",
	})
	if err != nil {
		t.Fatalf("PatchTask backward failed: %v", err)
	}

	c1Task, _ = store.GetTask("c1")
	if c1Task.DueDate == nil || *c1Task.DueDate != "2026-10-24 15:00" {
		t.Errorf("Expected c1 due date 2026-10-24 15:00, got %v", c1Task.DueDate)
	}

	c2Task, _ = store.GetTask("c2")
	if c2Task.DueDate == nil || *c2Task.DueDate != "2026-10-26" {
		t.Errorf("Expected c2 due date 2026-10-26, got %v", c2Task.DueDate)
	}

	gTask, _ = store.GetTask("g")
	if gTask.DueDate == nil || *gTask.DueDate != "2026-10-27 18:45" {
		t.Errorf("Expected g due date 2026-10-27 18:45, got %v", gTask.DueDate)
	}

	// 3. Time change only (same day 2026-10-22 20:00, delta = 0 days)
	_, err = store.PatchTask("p", map[string]interface{}{
		"due_date": "2026-10-22 20:00",
	})
	if err != nil {
		t.Fatalf("PatchTask time only failed: %v", err)
	}

	c1Task, _ = store.GetTask("c1")
	if c1Task.DueDate == nil || *c1Task.DueDate != "2026-10-24 15:00" {
		t.Errorf("Expected c1 due date unchanged at 2026-10-24 15:00, got %v", c1Task.DueDate)
	}

	gTask, _ = store.GetTask("g")
	if gTask.DueDate == nil || *gTask.DueDate != "2026-10-27 18:45" {
		t.Errorf("Expected g due date unchanged at 2026-10-27 18:45, got %v", gTask.DueDate)
	}
}


