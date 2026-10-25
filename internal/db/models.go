package db

import "time"

// Project groups sections and tasks. Projects nest without depth limit.
type Project struct {
	ID        string     `json:"id"`
	ParentID  *string    `json:"parent_id"`
	Name      string     `json:"name"`
	Position  int        `json:"position"`
	SortBy    string     `json:"sort_by"` // manual | date | priority | title
	CreatedAt time.Time  `json:"created_at"`
	Children  []*Project `json:"children"`
}

// Section is a named group of tasks inside a project.
type Section struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Name      string    `json:"name"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
}

// Task is a to-do item. Subtasks nest without depth limit and always share the
// project and section of their parent.
type Task struct {
	ID          string    `json:"id"`
	ProjectID   string    `json:"project_id"`
	ProjectName string    `json:"project_name"`
	SectionID   *string   `json:"section_id"`
	ParentID    *string   `json:"parent_id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Priority    int       `json:"priority"`   // 1 (urgent), 2 (high), 3 (normal)
	DueDate     *string   `json:"due_date"`   // "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"
	Recurrence  *string   `json:"recurrence"` // see parser.ValidRecurrence
	Location    *string   `json:"location"`
	Position    int       `json:"position"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Subtasks    []*Task   `json:"subtasks"`
}

// Placement positions an item among its siblings: just before BeforeID, just
// after AfterID, or at the end when both are empty.
type Placement struct {
	BeforeID string `json:"before_id"`
	AfterID  string `json:"after_id"`
}

// Sort orders accepted for a task list.
var validSorts = map[string]bool{"manual": true, "date": true, "priority": true, "title": true}

// ValidSort reports whether s is a supported sort order.
func ValidSort(s string) bool { return validSorts[s] }
