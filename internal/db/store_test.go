package db

import (
	"database/sql"
	"encoding/hex"
	"errors"
	"path/filepath"
	"testing"
)

const today = "2026-10-07" // a Wednesday

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func str(s string) *string { return &s }

func mustProject(t *testing.T, s *Store, name string, parent *string) *Project {
	t.Helper()
	p, err := s.CreateProject(name, parent)
	if err != nil {
		t.Fatalf("CreateProject(%q): %v", name, err)
	}
	return p
}

func mustSection(t *testing.T, s *Store, projectID, name string) *Section {
	t.Helper()
	sec, err := s.CreateSection(projectID, name)
	if err != nil {
		t.Fatalf("CreateSection(%q): %v", name, err)
	}
	return sec
}

func mustTask(t *testing.T, s *Store, in NewTask) *Task {
	t.Helper()
	task, err := s.CreateTask(in)
	if err != nil {
		t.Fatalf("CreateTask(%q): %v", in.Title, err)
	}
	return task
}

func mustGet(t *testing.T, s *Store, id string) *Task {
	t.Helper()
	task, err := s.GetTask(id)
	if err != nil {
		t.Fatalf("GetTask(%s): %v", id, err)
	}
	return task
}

func ids(tasks []*Task) []string {
	out := []string{}
	for _, t := range tasks {
		out = append(out, t.ID)
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func hexKey(b []byte) string { return hex.EncodeToString(b) }

func isInvalid(err error) bool {
	var v *ValidationError
	return errors.As(err, &v)
}

func TestProjectTree(t *testing.T) {
	s := openTest(t)
	work := mustProject(t, s, "Work", nil)
	clients := mustProject(t, s, "Clients", &work.ID)
	mustProject(t, s, "Acme", &clients.ID)
	mustProject(t, s, "Top", str(InboxID)) // "inbox" as parent means top level

	roots, err := s.ListProjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 2 || roots[0].Name != "Work" || roots[1].Name != "Top" || roots[1].ParentID != nil {
		t.Fatalf("unexpected roots: %+v", roots)
	}
	if roots[0].Children[0].Children[0].Name != "Acme" {
		t.Fatal("expected Work > Clients > Acme")
	}
	for _, p := range roots {
		if p.ID == InboxID {
			t.Fatal("the inbox must not be listed")
		}
	}
}

func TestMoveProject(t *testing.T) {
	s := openTest(t)
	a := mustProject(t, s, "A", nil)
	b := mustProject(t, s, "B", nil)
	c := mustProject(t, s, "C", &a.ID)

	if err := s.MoveProject(a.ID, &c.ID, Placement{}); !isInvalid(err) {
		t.Fatalf("moving a project into its own child must fail, got %v", err)
	}
	if err := s.MoveProject(b.ID, nil, Placement{BeforeID: a.ID}); err != nil {
		t.Fatal(err)
	}
	if err := s.MoveProject(c.ID, nil, Placement{AfterID: b.ID}); err != nil {
		t.Fatal(err)
	}
	roots, _ := s.ListProjects()
	var names []string
	for _, p := range roots {
		names = append(names, p.Name)
	}
	if !equal(names, []string{"B", "C", "A"}) {
		t.Fatalf("order = %v, want [B C A]", names)
	}
	if err := s.MoveProject(InboxID, nil, Placement{}); !isInvalid(err) {
		t.Fatal("the inbox must not move")
	}
	if err := s.DeleteProject(InboxID); !isInvalid(err) {
		t.Fatal("the inbox must not be deleted")
	}
}

func TestProjectSort(t *testing.T) {
	s := openTest(t)
	inbox, err := s.GetProject(InboxID)
	if err != nil || inbox.SortBy != "manual" {
		t.Fatalf("inbox default sort: %+v, %v", inbox, err)
	}
	if err := s.SetProjectSort(InboxID, "priority"); err != nil {
		t.Fatal(err)
	}
	if inbox, _ = s.GetProject(InboxID); inbox.SortBy != "priority" {
		t.Fatalf("inbox sort = %q", inbox.SortBy)
	}
	if err := s.SetProjectSort(InboxID, "random"); !isInvalid(err) {
		t.Fatal("unknown sort must be rejected")
	}
	if err := s.SetProjectSort("missing", "date"); err != ErrNotFound {
		t.Fatalf("missing project: %v", err)
	}
}

func TestTaskHierarchyAndCompletion(t *testing.T) {
	s := openTest(t)
	p := mustTask(t, s, NewTask{Title: "Prepare release", Priority: 1})
	c := mustTask(t, s, NewTask{Title: "Write docs", ParentID: &p.ID})
	g := mustTask(t, s, NewTask{Title: "Proofread", ParentID: &c.ID})

	list, err := s.ListTasks(TaskFilter{View: "inbox"})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Subtasks[0].ID != c.ID || list[0].Subtasks[0].Subtasks[0].ID != g.ID {
		t.Fatalf("unexpected tree: %+v", list)
	}

	done, err := s.CompleteTask(p.ID, today)
	if err != nil {
		t.Fatal(err)
	}
	if !done.Deleted || done.Task.Subtasks[0].Subtasks[0].ID != g.ID {
		t.Fatalf("completion must delete and return the full tree: %+v", done)
	}
	if list, _ = s.ListTasks(TaskFilter{View: "inbox"}); len(list) != 0 {
		t.Fatalf("tasks left after completion: %d", len(list))
	}

	// Undo puts the whole tree back, and doing it twice is harmless.
	for i := 0; i < 2; i++ {
		if err := s.RestoreTasks([]*Task{done.Task}, nil); err != nil {
			t.Fatal(err)
		}
	}
	restored := mustGet(t, s, p.ID)
	if len(restored.Subtasks) != 1 || len(restored.Subtasks[0].Subtasks) != 1 {
		t.Fatalf("restored tree incomplete: %+v", restored)
	}
}

func TestRestoreFallsBackWhenPlaceIsGone(t *testing.T) {
	s := openTest(t)
	proj := mustProject(t, s, "Temp", nil)
	sec := mustSection(t, s, proj.ID, "S")
	task := mustTask(t, s, NewTask{Title: "Orphan", ProjectID: proj.ID, SectionID: &sec.ID})
	done, _ := s.CompleteTask(task.ID, today)
	if err := s.DeleteProject(proj.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.RestoreTasks([]*Task{done.Task}, nil); err != nil {
		t.Fatalf("restore must not fail when the project is gone: %v", err)
	}
	got := mustGet(t, s, task.ID)
	if got.ProjectID != InboxID || got.SectionID != nil {
		t.Fatalf("expected fallback to the inbox, got %s / %v", got.ProjectID, got.SectionID)
	}
}

func TestRecurringCompletion(t *testing.T) {
	s := openTest(t)
	task := mustTask(t, s, NewTask{Title: "Meditate", DueDate: str("2026-10-07 07:00"), Recurrence: str("daily")})
	done, err := s.CompleteTask(task.ID, today)
	if err != nil {
		t.Fatal(err)
	}
	if done.Deleted || *done.Task.DueDate != "2026-10-08 07:00" || *done.PreviousDueDate != "2026-10-07 07:00" {
		t.Fatalf("unexpected completion: %+v", done)
	}
	if err := s.RestoreTasks(nil, []RestoreUpdate{{ID: task.ID, DueDate: done.PreviousDueDate}}); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, s, task.ID); *got.DueDate != "2026-10-07 07:00" {
		t.Fatalf("undo did not restore the due date: %v", *got.DueDate)
	}
}

func TestCreateValidation(t *testing.T) {
	s := openTest(t)
	cases := []NewTask{
		{Title: "   "},
		{Title: "x", Priority: 4},
		{Title: "x", DueDate: str("2026-02-30")},
		{Title: "x", Recurrence: str("sometimes")},
		{Title: "x", ProjectID: "missing"},
		{Title: "x", ParentID: str("missing")},
		{Title: "x", AfterID: "missing"},
	}
	for _, in := range cases {
		if _, err := s.CreateTask(in); !isInvalid(err) {
			t.Errorf("CreateTask(%+v) = %v, want a validation error", in, err)
		}
	}
	other := mustProject(t, s, "Other", nil)
	sec := mustSection(t, s, other.ID, "S")
	if _, err := s.CreateTask(NewTask{Title: "x", SectionID: &sec.ID}); !isInvalid(err) {
		t.Error("a section of another project must be rejected")
	}
	if _, err := s.CreateSection(InboxID, "S"); !isInvalid(err) {
		t.Error("the inbox has no sections")
	}
}

func TestSubtaskInheritsParentLocation(t *testing.T) {
	s := openTest(t)
	proj := mustProject(t, s, "P", nil)
	sec := mustSection(t, s, proj.ID, "S")
	parent := mustTask(t, s, NewTask{Title: "Parent", ProjectID: proj.ID, SectionID: &sec.ID})
	child := mustTask(t, s, NewTask{Title: "Child", ProjectID: InboxID, ParentID: &parent.ID})
	if child.ProjectID != proj.ID || child.SectionID == nil || *child.SectionID != sec.ID {
		t.Fatalf("subtask must live in its parent's project and section: %+v", child)
	}
}

func TestCreateAfter(t *testing.T) {
	s := openTest(t)
	a := mustTask(t, s, NewTask{Title: "A"})
	b := mustTask(t, s, NewTask{Title: "B"})
	n := mustTask(t, s, NewTask{Title: "New", AfterID: a.ID})
	list, _ := s.ListTasks(TaskFilter{View: "inbox"})
	if !equal(ids(list), []string{a.ID, n.ID, b.ID}) {
		t.Fatalf("order = %v", ids(list))
	}
}

func TestMoveTask(t *testing.T) {
	s := openTest(t)
	p1 := mustProject(t, s, "P1", nil)
	p2 := mustProject(t, s, "P2", nil)
	s2 := mustSection(t, s, p2.ID, "S2")
	parent := mustTask(t, s, NewTask{Title: "Parent", ProjectID: p1.ID})
	child := mustTask(t, s, NewTask{Title: "Child", ParentID: &parent.ID})
	grand := mustTask(t, s, NewTask{Title: "Grandchild", ParentID: &child.ID})
	other := mustTask(t, s, NewTask{Title: "Other", ProjectID: p2.ID, SectionID: &s2.ID})

	// Into another project and section: descendants follow.
	if _, err := s.MoveTask(parent.ID, TaskMove{ProjectID: p2.ID, SectionID: &s2.ID, Placement: Placement{BeforeID: other.ID}}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{parent.ID, child.ID, grand.ID} {
		got := mustGet(t, s, id)
		if got.ProjectID != p2.ID || got.SectionID == nil || *got.SectionID != s2.ID {
			t.Fatalf("task %s not moved with its parent: %+v", got.Title, got)
		}
	}
	list, _ := s.ListTasks(TaskFilter{View: "project", ProjectID: p2.ID})
	if !equal(ids(list), []string{parent.ID, other.ID}) {
		t.Fatalf("order = %v", ids(list))
	}

	// Cycles are refused.
	if _, err := s.MoveTask(parent.ID, TaskMove{ParentID: &grand.ID}); !isInvalid(err) {
		t.Fatalf("moving a task under its own descendant must fail, got %v", err)
	}
	if _, err := s.MoveTask(parent.ID, TaskMove{ParentID: &parent.ID}); !isInvalid(err) {
		t.Fatal("moving a task under itself must fail")
	}

	// Outdent the grandchild after its parent.
	if _, err := s.MoveTask(grand.ID, TaskMove{ParentID: &parent.ID, Placement: Placement{AfterID: child.ID}}); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, s, parent.ID); !equal(ids(got.Subtasks), []string{child.ID, grand.ID}) {
		t.Fatalf("subtasks = %v", ids(got.Subtasks))
	}

	// Back to the root of a project without section.
	if _, err := s.MoveTask(parent.ID, TaskMove{ProjectID: p1.ID}); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, s, grand.ID); got.ProjectID != p1.ID || got.SectionID != nil {
		t.Fatalf("grandchild not moved: %+v", got)
	}
}

func TestUpdateTaskShiftsSubtaskDates(t *testing.T) {
	s := openTest(t)
	p := mustTask(t, s, NewTask{Title: "Parent", DueDate: str("2026-10-20 10:00")})
	c1 := mustTask(t, s, NewTask{Title: "C1", ParentID: &p.ID, DueDate: str("2026-10-22 15:00")})
	c2 := mustTask(t, s, NewTask{Title: "C2", ParentID: &p.ID})
	g := mustTask(t, s, NewTask{Title: "G", ParentID: &c1.ID, DueDate: str("2026-10-25")})

	if _, err := s.UpdateTask(p.ID, TaskPatch{DueDate: Optional{Set: true, Value: str("2026-10-25 12:00")}}); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, s, c1.ID); *got.DueDate != "2026-10-27 15:00" {
		t.Errorf("c1 = %s", *got.DueDate)
	}
	if got := mustGet(t, s, g.ID); *got.DueDate != "2026-10-30" {
		t.Errorf("g = %s", *got.DueDate)
	}
	if got := mustGet(t, s, c2.ID); got.DueDate != nil {
		t.Error("a subtask without date must stay without date")
	}

	// Same day, other time: subtasks do not move.
	if _, err := s.UpdateTask(p.ID, TaskPatch{DueDate: Optional{Set: true, Value: str("2026-10-25 20:00")}}); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, s, c1.ID); *got.DueDate != "2026-10-27 15:00" {
		t.Errorf("c1 moved on a time-only change: %s", *got.DueDate)
	}

	// Clearing a field with null, leaving the others alone.
	got, err := s.UpdateTask(p.ID, TaskPatch{DueDate: Optional{Set: true}, Title: str("Renamed")})
	if err != nil {
		t.Fatal(err)
	}
	if got.DueDate != nil || got.Title != "Renamed" || got.Position != p.Position {
		t.Fatalf("unexpected patch result: %+v", got)
	}
}

func TestUpcomingAndCounts(t *testing.T) {
	s := openTest(t)
	proj := mustProject(t, s, "P", nil)
	mustTask(t, s, NewTask{Title: "Overdue", ProjectID: proj.ID, DueDate: str("2026-10-01")})
	mustTask(t, s, NewTask{Title: "Today", DueDate: str("2026-10-07")})
	mustTask(t, s, NewTask{Title: "Last shown day", DueDate: str("2026-10-13")})
	mustTask(t, s, NewTask{Title: "Too far", DueDate: str("2026-10-14")})
	mustTask(t, s, NewTask{Title: "No date"})

	up, err := s.ListTasks(TaskFilter{View: "upcoming", Today: today})
	if err != nil {
		t.Fatal(err)
	}
	if len(up) != 3 || up[0].Title != "Overdue" || up[2].Title != "Last shown day" {
		t.Fatalf("upcoming = %v", ids(up))
	}
	c, err := s.Counts(today)
	if err != nil {
		t.Fatal(err)
	}
	if c.Inbox != 4 || c.Upcoming != 3 || c.Projects[proj.ID] != "overdue" || c.Projects[InboxID] != "today" {
		t.Fatalf("counts = %+v", c)
	}
}

func TestSectionsAndCascade(t *testing.T) {
	s := openTest(t)
	p1 := mustProject(t, s, "P1", nil)
	p2 := mustProject(t, s, "P2", nil)
	a := mustSection(t, s, p1.ID, "A")
	b := mustSection(t, s, p1.ID, "B")
	parent := mustTask(t, s, NewTask{Title: "In A", ProjectID: p1.ID, SectionID: &a.ID})
	child := mustTask(t, s, NewTask{Title: "Child", ParentID: &parent.ID})

	if err := s.MoveSection(b.ID, "", Placement{BeforeID: a.ID}); err != nil {
		t.Fatal(err)
	}
	secs, _ := s.ListSections(p1.ID)
	if secs[0].ID != b.ID || secs[1].ID != a.ID {
		t.Fatal("section reorder failed")
	}
	if err := s.MoveSection(a.ID, p2.ID, Placement{}); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, s, child.ID); got.ProjectID != p2.ID {
		t.Fatal("tasks must follow their section to the new project")
	}
	if err := s.DeleteSection(a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetTask(parent.ID); err != ErrNotFound {
		t.Fatal("deleting a section must delete its tasks")
	}
}

func TestSearchEscapesWildcards(t *testing.T) {
	s := openTest(t)
	mustTask(t, s, NewTask{Title: "100% done"})
	mustTask(t, s, NewTask{Title: "1000 things"})
	got, err := s.SearchTasks("0%")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Title != "100% done" {
		t.Fatalf("search = %+v", got)
	}
}

func TestPasswordsAndSessions(t *testing.T) {
	s := openTest(t)
	if has, _ := s.HasPassword(); has {
		t.Fatal("fresh store must have no password")
	}
	if err := s.SetInitialPassword("abc"); !isInvalid(err) {
		t.Fatal("short password must be rejected")
	}
	if err := s.SetInitialPassword(" secret "); err != nil {
		t.Fatal(err)
	}
	if err := s.SetInitialPassword("another"); !isInvalid(err) {
		t.Fatal("initial password must not be overwritten")
	}
	if ok, _ := s.VerifyPassword(" secret "); !ok {
		t.Fatal("password with spaces must be kept as typed")
	}
	if ok, _ := s.VerifyPassword("secret"); ok {
		t.Fatal("wrong password accepted")
	}
	token, err := s.CreateSession()
	if err != nil || !s.ValidateSession(token) {
		t.Fatal("session not valid")
	}
	if err := s.SetPassword("new password"); err != nil {
		t.Fatal(err)
	}
	if s.ValidateSession(token) {
		t.Fatal("changing the password must sign out every session")
	}
}

func TestLegacyPasswordIsUpgraded(t *testing.T) {
	s := openTest(t)
	salt := []byte("0123456789abcdef")
	legacy := "30313233343536373839616263646566$" + hexKey(legacyKey("hunter2", salt))
	if _, err := s.db.Exec(`INSERT INTO auth_settings (key, value) VALUES ('password_hash', ?)`, legacy); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.VerifyPassword("hunter2"); !ok {
		t.Fatal("legacy hash must still verify")
	}
	var stored string
	s.db.QueryRow(`SELECT value FROM auth_settings`).Scan(&stored)
	if stored[:3] != "v2$" {
		t.Fatalf("hash not upgraded: %s", stored)
	}
	if ok, _ := s.VerifyPassword("hunter2"); !ok {
		t.Fatal("upgraded hash must verify")
	}
}

func TestMigrationRepairsLegacyData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	raw, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(migrations[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`
		INSERT INTO projects (id, name) VALUES ('inbox', 'Inbox'), ('p1', 'P1'), ('p2', 'P2');
		INSERT INTO sections (id, project_id, name) VALUES ('s1', 'p1', 'S1');
		INSERT INTO tasks (id, project_id, section_id, title, priority) VALUES ('root', 'p1', 's1', 'Root', 4);
		INSERT INTO tasks (id, project_id, parent_id, title, priority) VALUES ('child', 'p2', 'root', 'Child', 2);
		INSERT INTO auth_sessions (token) VALUES ('plain-token');`); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	root, child := mustGet(t, s, "root"), mustGet(t, s, "child")
	if root.Priority != 3 {
		t.Errorf("priority 4 must become 3, got %d", root.Priority)
	}
	if child.ProjectID != "p1" || child.SectionID == nil || *child.SectionID != "s1" {
		t.Errorf("subtask must be moved to its parent's place: %+v", child)
	}
	if s.ValidateSession("plain-token") {
		t.Error("unhashed sessions must be dropped")
	}
}
