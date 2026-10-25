package db

import (
	"database/sql"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/ben/get-done/internal/parser"
)

const (
	maxTitleLength       = 500
	maxDescriptionLength = 20000
	maxLocationLength    = 500
	defaultPriority      = 3
	// The upcoming view shows overdue tasks and the next upcomingDays days.
	upcomingDays = 7
	searchLimit  = 50
)

const taskColumns = `t.id, t.project_id, COALESCE(p.name, ''), t.section_id, t.parent_id, t.title,
	COALESCE(t.description, ''), t.priority, t.due_date, t.recurrence, t.location,
	t.position, t.created_at, t.updated_at`

const taskFrom = ` FROM tasks t LEFT JOIN projects p ON p.id = t.project_id `

func scanTask(sc interface{ Scan(...any) error }) (*Task, error) {
	t := &Task{Subtasks: []*Task{}}
	var sectionID, parentID, due, recurrence, location sql.NullString
	err := sc.Scan(&t.ID, &t.ProjectID, &t.ProjectName, &sectionID, &parentID, &t.Title,
		&t.Description, &t.Priority, &due, &recurrence, &location,
		&t.Position, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	t.SectionID, t.ParentID = ptr(sectionID), ptr(parentID)
	t.DueDate, t.Recurrence, t.Location = ptr(due), ptr(recurrence), ptr(location)
	return t, nil
}

func queryTasks(q querier, query string, args ...any) ([]*Task, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []*Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}

// buildTree attaches each task to its parent when the parent is in the list,
// keeping the list order among siblings. It returns the remaining roots.
func buildTree(tasks []*Task) []*Task {
	byID := make(map[string]*Task, len(tasks))
	for _, t := range tasks {
		byID[t.ID] = t
	}
	roots := []*Task{}
	for _, t := range tasks {
		if t.ParentID != nil {
			if parent, ok := byID[*t.ParentID]; ok {
				parent.Subtasks = append(parent.Subtasks, t)
				continue
			}
		}
		roots = append(roots, t)
	}
	return roots
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// TaskFilter selects the tasks of a view.
type TaskFilter struct {
	View      string // inbox | project | upcoming
	ProjectID string // for the project view
	Sort      string // manual | date | priority | title (ignored by upcoming)
	Today     string // "YYYY-MM-DD", the user's current day
}

var sortClauses = map[string]string{
	"manual":   "t.position, t.created_at",
	"priority": "t.priority, t.position, t.created_at",
	"date":     "t.due_date IS NULL, t.due_date, t.priority, t.position",
	"title":    "t.title COLLATE NOCASE, t.position",
}

// ListTasks returns the tasks of a view. Inbox and project views return a
// tree; the upcoming view returns a flat list ordered by due date, because each
// task belongs to the day it is due on.
func (s *Store) ListTasks(f TaskFilter) ([]*Task, error) {
	order, ok := sortClauses[f.Sort]
	if !ok {
		order = sortClauses["manual"]
	}
	var where string
	var args []any
	switch f.View {
	case "inbox":
		where = "t.project_id = 'inbox'"
	case "project":
		if _, err := s.GetProject(f.ProjectID); err != nil {
			return nil, err
		}
		where, args = "t.project_id = ?", []any{f.ProjectID}
	case "upcoming":
		where, args = "t.due_date IS NOT NULL AND substr(t.due_date, 1, 10) <= ?", []any{upcomingEnd(f.Today)}
		order = "t.due_date, t.priority, t.position, t.created_at"
	default:
		return nil, invalid("unknown view %q", f.View)
	}
	tasks, err := queryTasks(s.db, `SELECT `+taskColumns+taskFrom+`WHERE `+where+` ORDER BY `+order, args...)
	if err != nil || f.View == "upcoming" {
		return tasks, err
	}
	return buildTree(tasks), nil
}

// upcomingEnd returns the last day shown by the upcoming view.
func upcomingEnd(today string) string {
	end, _ := parser.ShiftDue(parser.NormalizeToday(today), upcomingDays-1)
	return end
}

// GetTask returns a task with all its subtasks.
func (s *Store) GetTask(id string) (*Task, error) {
	return getTaskTree(s.db, id)
}

func getTaskTree(q querier, id string) (*Task, error) {
	tasks, err := queryTasks(q, `WITH RECURSIVE sub(id) AS (
			SELECT ? UNION SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
		SELECT `+taskColumns+taskFrom+`WHERE t.id IN (SELECT id FROM sub) ORDER BY t.position, t.created_at`, id)
	if err != nil {
		return nil, err
	}
	for _, root := range buildTree(tasks) {
		if root.ID == id {
			return root, nil
		}
	}
	return nil, ErrNotFound
}

// SearchTasks returns tasks whose title, description or location contains query.
func (s *Store) SearchTasks(query string) ([]*Task, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []*Task{}, nil
	}
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(query)
	pattern := "%" + escaped + "%"
	return queryTasks(s.db, `SELECT `+taskColumns+taskFrom+`
		WHERE t.title LIKE ? ESCAPE '\' OR t.description LIKE ? ESCAPE '\' OR t.location LIKE ? ESCAPE '\'
		ORDER BY t.priority, t.due_date IS NULL, t.due_date, t.created_at DESC
		LIMIT ?`, pattern, pattern, pattern, searchLimit)
}

// Counts summarizes the sidebar: how many tasks are in the inbox and in the
// upcoming view, and which projects have overdue tasks or tasks due today.
type Counts struct {
	Inbox    int               `json:"inbox"`
	Upcoming int               `json:"upcoming"`
	Projects map[string]string `json:"projects"` // project id -> "overdue" | "today"
}

// Counts computes the sidebar summary for the user's current day.
func (s *Store) Counts(today string) (*Counts, error) {
	today = parser.NormalizeToday(today)
	c := &Counts{Projects: map[string]string{}}
	err := s.db.QueryRow(`SELECT
			(SELECT COUNT(*) FROM tasks WHERE project_id = 'inbox'),
			(SELECT COUNT(*) FROM tasks WHERE due_date IS NOT NULL AND substr(due_date, 1, 10) <= ?)`,
		upcomingEnd(today)).Scan(&c.Inbox, &c.Upcoming)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT project_id, MIN(substr(due_date, 1, 10)) FROM tasks
		WHERE due_date IS NOT NULL AND substr(due_date, 1, 10) <= ? GROUP BY project_id`, today)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var projectID, earliest string
		if err := rows.Scan(&projectID, &earliest); err != nil {
			return nil, err
		}
		if earliest < today {
			c.Projects[projectID] = "overdue"
		} else {
			c.Projects[projectID] = "today"
		}
	}
	return c, rows.Err()
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

func normalizeTitle(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", invalid("Task title is required")
	}
	if utf8.RuneCountInString(s) > maxTitleLength {
		return "", invalid("Task title is too long (%d characters max)", maxTitleLength)
	}
	return s, nil
}

func normalizeDescription(s string) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > maxDescriptionLength {
		return "", invalid("Description is too long (%d characters max)", maxDescriptionLength)
	}
	return s, nil
}

func normalizePriority(p int) (int, error) {
	if p == 0 {
		return defaultPriority, nil
	}
	if p < 1 || p > 3 {
		return 0, invalid("Priority must be 1, 2 or 3")
	}
	return p, nil
}

// clean trims an optional string and turns "" into nil.
func clean(s *string) *string {
	if s == nil {
		return nil
	}
	v := strings.TrimSpace(*s)
	if v == "" {
		return nil
	}
	return &v
}

func normalizeDue(s *string) (*string, error) {
	s = clean(s)
	if s != nil && !parser.ValidDue(*s) {
		return nil, invalid("Invalid due date %q (expected YYYY-MM-DD or YYYY-MM-DD HH:MM)", *s)
	}
	return s, nil
}

func normalizeRecurrence(s *string) (*string, error) {
	s = clean(s)
	if s == nil {
		return nil, nil
	}
	rule := parser.NormalizeRecurrence(*s)
	if !parser.ValidRecurrence(rule) {
		return nil, invalid("Invalid recurrence %q", *s)
	}
	return &rule, nil
}

func normalizeLocation(s *string) (*string, error) {
	s = clean(s)
	if s != nil && utf8.RuneCountInString(*s) > maxLocationLength {
		return nil, invalid("Location is too long (%d characters max)", maxLocationLength)
	}
	return s, nil
}

// ---------------------------------------------------------------------------
// Placement of tasks
// ---------------------------------------------------------------------------

// slot is a list of sibling tasks: the subtasks of a parent, or the top-level
// tasks of a section (or of a project outside any section).
type slot struct {
	projectID string
	sectionID *string
	parentID  *string
}

func (sl slot) siblings(q querier, exclude string) ([]string, error) {
	if sl.parentID != nil {
		return queryIDs(q, `SELECT id FROM tasks WHERE parent_id = ? AND id != ?
			ORDER BY position, created_at`, *sl.parentID, exclude)
	}
	return queryIDs(q, `SELECT id FROM tasks WHERE project_id = ? AND section_id IS ? AND parent_id IS NULL AND id != ?
		ORDER BY position, created_at`, sl.projectID, nullable(sl.sectionID), exclude)
}

func (sl slot) maxPosition(q querier) (int, error) {
	var maxPos int
	var err error
	if sl.parentID != nil {
		err = q.QueryRow(`SELECT COALESCE(MAX(position), 0) FROM tasks WHERE parent_id = ?`, *sl.parentID).Scan(&maxPos)
	} else {
		err = q.QueryRow(`SELECT COALESCE(MAX(position), 0) FROM tasks
			WHERE project_id = ? AND section_id IS ? AND parent_id IS NULL`, sl.projectID, nullable(sl.sectionID)).Scan(&maxPos)
	}
	return maxPos, err
}

// resolveSlot validates a destination. A subtask always takes the project and
// section of its parent.
func resolveSlot(q querier, projectID string, sectionID, parentID *string) (slot, error) {
	if parentID != nil {
		var parentProject string
		var parentSection sql.NullString
		err := q.QueryRow(`SELECT project_id, section_id FROM tasks WHERE id = ?`, *parentID).Scan(&parentProject, &parentSection)
		if err == sql.ErrNoRows {
			return slot{}, invalid("the parent task does not exist")
		}
		if err != nil {
			return slot{}, err
		}
		return slot{projectID: parentProject, sectionID: ptr(parentSection), parentID: parentID}, nil
	}
	if projectID == "" {
		projectID = InboxID
	}
	if err := requireSectionProject(q, projectID, sectionID); err != nil {
		return slot{}, err
	}
	return slot{projectID: projectID, sectionID: sectionID}, nil
}

// cascadeLocation gives every descendant of id the project and section of sl.
func cascadeLocation(q querier, id string, sl slot) error {
	_, err := q.Exec(`WITH RECURSIVE sub(id) AS (
			SELECT id FROM tasks WHERE parent_id = ? UNION SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
		UPDATE tasks SET project_id = ?, section_id = ?, updated_at = ? WHERE id IN (SELECT id FROM sub)`,
		id, sl.projectID, nullable(sl.sectionID), now())
	return err
}

// shiftDescendantDates moves the due dates of every descendant of id by days.
func shiftDescendantDates(q querier, id string, days int) error {
	rows, err := q.Query(`WITH RECURSIVE sub(id) AS (
			SELECT id FROM tasks WHERE parent_id = ? UNION SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
		SELECT id, due_date FROM tasks WHERE id IN (SELECT id FROM sub) AND due_date IS NOT NULL`, id)
	if err != nil {
		return err
	}
	type dated struct{ id, due string }
	var items []dated
	for rows.Next() {
		var d dated
		if err := rows.Scan(&d.id, &d.due); err != nil {
			rows.Close()
			return err
		}
		items = append(items, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	ts := now()
	for _, d := range items {
		shifted, ok := parser.ShiftDue(d.due, days)
		if !ok {
			continue
		}
		if _, err := q.Exec(`UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?`, shifted, ts, d.id); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// NewTask describes a task to create. With ParentID set, the task becomes a
// subtask and ProjectID/SectionID are taken from the parent. With AfterID set,
// it is inserted right after that sibling instead of at the end.
type NewTask struct {
	ProjectID   string  `json:"project_id"`
	SectionID   *string `json:"section_id"`
	ParentID    *string `json:"parent_id"`
	AfterID     string  `json:"after_id"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Priority    int     `json:"priority"`
	DueDate     *string `json:"due_date"`
	Recurrence  *string `json:"recurrence"`
	Location    *string `json:"location"`
}

// CreateTask validates and inserts a task.
func (s *Store) CreateTask(in NewTask) (*Task, error) {
	title, err := normalizeTitle(in.Title)
	if err != nil {
		return nil, err
	}
	description, err := normalizeDescription(in.Description)
	if err != nil {
		return nil, err
	}
	priority, err := normalizePriority(in.Priority)
	if err != nil {
		return nil, err
	}
	due, err := normalizeDue(in.DueDate)
	if err != nil {
		return nil, err
	}
	recurrence, err := normalizeRecurrence(in.Recurrence)
	if err != nil {
		return nil, err
	}
	location, err := normalizeLocation(in.Location)
	if err != nil {
		return nil, err
	}

	id := newID()
	err = s.tx(func(tx *sql.Tx) error {
		sl, err := resolveSlot(tx, strings.TrimSpace(in.ProjectID), clean(in.SectionID), clean(in.ParentID))
		if err != nil {
			return err
		}
		position := 0
		if in.AfterID == "" {
			maxPos, err := sl.maxPosition(tx)
			if err != nil {
				return err
			}
			position = maxPos + 1
		}
		ts := now()
		if _, err := tx.Exec(`INSERT INTO tasks (id, project_id, section_id, parent_id, title, description,
				priority, due_date, recurrence, location, position, is_collapsed, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
			id, sl.projectID, nullable(sl.sectionID), nullable(sl.parentID), title, description,
			priority, nullable(due), nullable(recurrence), nullable(location), position, ts, ts); err != nil {
			return err
		}
		if in.AfterID == "" {
			return nil
		}
		siblings, err := sl.siblings(tx, id)
		if err != nil {
			return err
		}
		order, err := place(siblings, id, Placement{AfterID: in.AfterID})
		if err != nil {
			return err
		}
		return renumber(tx, "tasks", order)
	})
	if err != nil {
		return nil, err
	}
	return s.GetTask(id)
}

// Optional is a JSON value that tells an absent field apart from null.
type Optional struct {
	Set   bool
	Value *string
}

// UnmarshalJSON is only called when the field is present.
func (o *Optional) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var v string
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

// TaskPatch lists the fields to change; absent fields are left untouched.
// Moving a task (project, section, parent, order) goes through MoveTask.
type TaskPatch struct {
	Title       *string  `json:"title"`
	Description *string  `json:"description"`
	Priority    *int     `json:"priority"`
	DueDate     Optional `json:"due_date"`
	Recurrence  Optional `json:"recurrence"`
	Location    Optional `json:"location"`
}

// UpdateTask applies a patch. When the due date moves to another day, the due
// dates of all subtasks move by the same number of days.
func (s *Store) UpdateTask(id string, p TaskPatch) (*Task, error) {
	err := s.tx(func(tx *sql.Tx) error {
		t, err := scanTask(tx.QueryRow(`SELECT `+taskColumns+taskFrom+`WHERE t.id = ?`, id))
		if err == sql.ErrNoRows {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		oldDue := t.DueDate
		if p.Title != nil {
			if t.Title, err = normalizeTitle(*p.Title); err != nil {
				return err
			}
		}
		if p.Description != nil {
			if t.Description, err = normalizeDescription(*p.Description); err != nil {
				return err
			}
		}
		if p.Priority != nil {
			if *p.Priority == 0 {
				return invalid("Priority must be 1, 2 or 3")
			}
			if t.Priority, err = normalizePriority(*p.Priority); err != nil {
				return err
			}
		}
		if p.DueDate.Set {
			if t.DueDate, err = normalizeDue(p.DueDate.Value); err != nil {
				return err
			}
		}
		if p.Recurrence.Set {
			if t.Recurrence, err = normalizeRecurrence(p.Recurrence.Value); err != nil {
				return err
			}
		}
		if p.Location.Set {
			if t.Location, err = normalizeLocation(p.Location.Value); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`UPDATE tasks SET title = ?, description = ?, priority = ?, due_date = ?,
				recurrence = ?, location = ?, updated_at = ? WHERE id = ?`,
			t.Title, t.Description, t.Priority, nullable(t.DueDate), nullable(t.Recurrence), nullable(t.Location), now(), id); err != nil {
			return err
		}
		if oldDue != nil && t.DueDate != nil {
			if days, ok := parser.DaysBetween(*oldDue, *t.DueDate); ok && days != 0 {
				return shiftDescendantDates(tx, id, days)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetTask(id)
}

// TaskMove describes where to move a task. With ParentID set the task becomes
// a subtask of that task; otherwise it becomes a top-level task of ProjectID
// (its current project when empty) in SectionID (no section when nil).
type TaskMove struct {
	ProjectID string  `json:"project_id"`
	SectionID *string `json:"section_id"`
	ParentID  *string `json:"parent_id"`
	Placement
}

// MoveTask moves a task, with its subtasks, to a new place.
func (s *Store) MoveTask(id string, m TaskMove) (*Task, error) {
	err := s.tx(func(tx *sql.Tx) error {
		var currentProject string
		err := tx.QueryRow(`SELECT project_id FROM tasks WHERE id = ?`, id).Scan(&currentProject)
		if err == sql.ErrNoRows {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		parentID := clean(m.ParentID)
		projectID := strings.TrimSpace(m.ProjectID)
		if projectID == "" {
			projectID = currentProject
		}
		if parentID != nil {
			cycle, err := exists(tx, `WITH RECURSIVE sub(id) AS (
					SELECT ? UNION SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
				SELECT 1 FROM sub WHERE id = ?`, id, *parentID)
			if err != nil {
				return err
			}
			if cycle {
				return invalid("a task cannot be moved inside itself")
			}
		}
		sl, err := resolveSlot(tx, projectID, clean(m.SectionID), parentID)
		if err != nil {
			return err
		}
		siblings, err := sl.siblings(tx, id)
		if err != nil {
			return err
		}
		order, err := place(siblings, id, m.Placement)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE tasks SET project_id = ?, section_id = ?, parent_id = ?, updated_at = ? WHERE id = ?`,
			sl.projectID, nullable(sl.sectionID), nullable(sl.parentID), now(), id); err != nil {
			return err
		}
		if err := cascadeLocation(tx, id, sl); err != nil {
			return err
		}
		return renumber(tx, "tasks", order)
	})
	if err != nil {
		return nil, err
	}
	return s.GetTask(id)
}

// DeleteTask deletes a task and its subtasks.
func (s *Store) DeleteTask(id string) error {
	res, err := s.db.Exec(`DELETE FROM tasks WHERE id = ?`, id)
	return requireAffected(res, err)
}

// Completion is the outcome of completing a task.
type Completion struct {
	// Deleted is true for a one-off task: it was removed with its subtasks and
	// Task holds the full removed tree, so that it can be restored.
	// For a recurring task, Deleted is false and Task holds the rescheduled task.
	Deleted         bool    `json:"deleted"`
	Task            *Task   `json:"task"`
	PreviousDueDate *string `json:"previous_due_date"`
}

// CompleteTask completes a task. A recurring task moves to its next
// occurrence; any other task is deleted together with its subtasks.
func (s *Store) CompleteTask(id, today string) (*Completion, error) {
	var c Completion
	err := s.tx(func(tx *sql.Tx) error {
		t, err := getTaskTree(tx, id)
		if err != nil {
			return err
		}
		c.PreviousDueDate = t.DueDate
		if t.Recurrence == nil {
			c.Deleted, c.Task = true, t
			_, err := tx.Exec(`DELETE FROM tasks WHERE id = ?`, id)
			return err
		}
		due := ""
		if t.DueDate != nil {
			due = *t.DueDate
		}
		next := parser.NextDueDate(due, *t.Recurrence, today)
		if _, err := tx.Exec(`UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?`, next, now(), id); err != nil {
			return err
		}
		t.DueDate, c.Task = &next, t
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// RestoreUpdate puts back the due date of a recurring task.
type RestoreUpdate struct {
	ID      string  `json:"id"`
	DueDate *string `json:"due_date"`
}

// RestoreTasks undoes completions: deleted trees are inserted again with their
// original ids, and recurring tasks get their previous due date back. A tree is
// reattached to its original project, section and parent when they still
// exist, and falls back to the inbox otherwise. Tasks that already exist are
// left untouched, so restoring twice is harmless.
func (s *Store) RestoreTasks(trees []*Task, updates []RestoreUpdate) error {
	return s.tx(func(tx *sql.Tx) error {
		for _, u := range updates {
			due, err := normalizeDue(u.DueDate)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?`, nullable(due), now(), u.ID); err != nil {
				return err
			}
		}
		for _, t := range trees {
			if err := restoreTree(tx, t, nil); err != nil {
				return err
			}
		}
		return nil
	})
}

func restoreTree(tx *sql.Tx, t *Task, parent *slot) error {
	if t == nil || strings.TrimSpace(t.ID) == "" {
		return nil
	}
	if found, err := exists(tx, `SELECT 1 FROM tasks WHERE id = ?`, t.ID); err != nil || found {
		return err
	}

	var sl slot
	if parent != nil {
		sl = *parent
	} else {
		sl = originalSlot(tx, t)
	}

	title, err := normalizeTitle(t.Title)
	if err != nil {
		title = "Untitled"
	}
	description, _ := normalizeDescription(t.Description)
	priority, err := normalizePriority(t.Priority)
	if err != nil {
		priority = defaultPriority
	}
	due, _ := normalizeDue(t.DueDate)
	recurrence, _ := normalizeRecurrence(t.Recurrence)
	location, _ := normalizeLocation(t.Location)
	createdAt := t.CreatedAt
	if createdAt.IsZero() {
		createdAt = now()
	}

	if _, err := tx.Exec(`INSERT INTO tasks (id, project_id, section_id, parent_id, title, description,
			priority, due_date, recurrence, location, position, is_collapsed, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		t.ID, sl.projectID, nullable(sl.sectionID), nullable(sl.parentID), title, description,
		priority, nullable(due), nullable(recurrence), nullable(location), t.Position, createdAt, now()); err != nil {
		return err
	}
	child := slot{projectID: sl.projectID, sectionID: sl.sectionID, parentID: &t.ID}
	for _, sub := range t.Subtasks {
		if err := restoreTree(tx, sub, &child); err != nil {
			return err
		}
	}
	return nil
}

// originalSlot finds where a restored root task should go, falling back to
// the inbox when its original place no longer exists.
func originalSlot(q querier, t *Task) slot {
	if parentID := clean(t.ParentID); parentID != nil {
		if sl, err := resolveSlot(q, "", nil, parentID); err == nil {
			return sl
		}
	}
	if projectID := strings.TrimSpace(t.ProjectID); projectID != "" {
		if sl, err := resolveSlot(q, projectID, clean(t.SectionID), nil); err == nil {
			return sl
		}
		if sl, err := resolveSlot(q, projectID, nil, nil); err == nil {
			return sl
		}
	}
	return slot{projectID: InboxID}
}
