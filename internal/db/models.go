package db

import "time"

// Project represents a project/folder with infinite nesting support.
type Project struct {
	ID        string     `json:"id"`
	ParentID  *string    `json:"parent_id"`
	Name      string     `json:"name"`
	Icon      string     `json:"icon"`
	Position  int        `json:"position"`
	SortBy    string     `json:"sort_by"`
	SortOrder string     `json:"sort_order"`
	CreatedAt time.Time  `json:"created_at"`
	Children  []*Project `json:"children,omitempty"`
}

// Section represents a section inside a project (like Todoist sections).
type Section struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Name      string    `json:"name"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
}

// Task represents a task or subtask with infinite nesting support.
type Task struct {
	ID          string    `json:"id"`
	ProjectID   string    `json:"project_id"`
	SectionID   *string   `json:"section_id"`
	ParentID    *string   `json:"parent_id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Priority    int       `json:"priority"` // 1 (Urgent), 2 (High), 3 (Normal)
	DueDate     *string   `json:"due_date"` // "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"
	Recurrence  *string   `json:"recurrence"` // "daily", "weekly", "monthly", etc.
	Location    *string   `json:"location"` // Address or location name
	Position    int       `json:"position"`
	IsCollapsed bool      `json:"is_collapsed"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Subtasks    []*Task   `json:"subtasks,omitempty"`
	ProjectName string    `json:"project_name,omitempty"`
}

// QuickAddParsed represents the parsed tokens from a quick-add input string.
type QuickAddParsed struct {
	Title       string  `json:"title"`
	ProjectName *string `json:"project_name"`
	Priority    int     `json:"priority"`
	DueDate     *string `json:"due_date"`
	Recurrence  *string `json:"recurrence"`
	Location    *string `json:"location"`
}
