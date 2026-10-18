package db

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

// NewStore initializes the SQLite database with WAL mode and tables.
func NewStore(dbPath string) (*Store, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create db directory: %w", err)
	}

	dsn := fmt.Sprintf("%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)", dbPath)
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database: %w", err)
	}

	s := &Store{db: database}
	if err := s.migrate(); err != nil {
		database.Close()
		return nil, fmt.Errorf("migration failed: %w", err)
	}

	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// RunInTx runs the specified callback function inside a database transaction.
func (s *Store) RunInTx(fn func(tx *sql.Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS projects (
		id TEXT PRIMARY KEY,
		parent_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		icon TEXT DEFAULT '',
		position INTEGER NOT NULL DEFAULT 0,
		sort_by TEXT NOT NULL DEFAULT 'manual',
		sort_order TEXT NOT NULL DEFAULT 'asc',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id);

	CREATE TABLE IF NOT EXISTS sections (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		position INTEGER NOT NULL DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	CREATE INDEX IF NOT EXISTS idx_sections_project ON sections(project_id);

	CREATE TABLE IF NOT EXISTS tasks (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		section_id TEXT REFERENCES sections(id) ON DELETE CASCADE,
		parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		description TEXT DEFAULT '',
		priority INTEGER NOT NULL DEFAULT 4,
		due_date TEXT,
		recurrence TEXT,
		location TEXT,
		position INTEGER NOT NULL DEFAULT 0,
		is_collapsed INTEGER NOT NULL DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
	CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
	CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);

	CREATE TABLE IF NOT EXISTS auth_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS auth_sessions (
		token TEXT PRIMARY KEY,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`

	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	// Check if sort_by and sort_order columns exist on projects table
	pRows, err := s.db.Query("PRAGMA table_info(projects)")
	if err == nil {
		hasSortBy := false
		hasSortOrder := false
		for pRows.Next() {
			var cid int
			var name, ctype string
			var notnull, pk int
			var dfltValue sql.NullString
			if err := pRows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err == nil {
				if name == "sort_by" {
					hasSortBy = true
				}
				if name == "sort_order" {
					hasSortOrder = true
				}
			}
		}
		pRows.Close()
		if !hasSortBy {
			if _, err := s.db.Exec("ALTER TABLE projects ADD COLUMN sort_by TEXT NOT NULL DEFAULT 'manual'"); err != nil {
				return err
			}
		}
		if !hasSortOrder {
			if _, err := s.db.Exec("ALTER TABLE projects ADD COLUMN sort_order TEXT NOT NULL DEFAULT 'asc'"); err != nil {
				return err
			}
		}
	}

	// Check if section_id column exists on tasks table for backwards compatibility
	rows, err := s.db.Query("PRAGMA table_info(tasks)")
	if err == nil {
		hasSectionID := false
		for rows.Next() {
			var cid int
			var name, ctype string
			var notnull, pk int
			var dfltValue sql.NullString
			if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err == nil {
				if name == "section_id" {
					hasSectionID = true
				}
			}
		}
		rows.Close()
		if !hasSectionID {
			if _, err := s.db.Exec("ALTER TABLE tasks ADD COLUMN section_id TEXT REFERENCES sections(id) ON DELETE CASCADE"); err != nil {
				return err
			}
		}
	}

	// Safely create index on section_id after column exists
	if _, err := s.db.Exec("CREATE INDEX IF NOT EXISTS idx_tasks_section ON tasks(section_id)"); err != nil {
		return err
	}

	// Ensure default 'inbox' project exists
	var count int
	err = s.db.QueryRow("SELECT COUNT(*) FROM projects WHERE id = 'inbox'").Scan(&count)
	if err != nil {
		return err
	}
	if count == 0 {
		_, err = s.db.Exec(`
			INSERT INTO projects (id, parent_id, name, icon, position, sort_by, sort_order)
			VALUES ('inbox', NULL, 'Inbox', '', 0, 'manual', 'asc')
		`)
		if err != nil {
			return err
		}
	} else {
		_, _ = s.db.Exec(`UPDATE projects SET name = 'Inbox' WHERE id = 'inbox' AND name = 'Boîte de réception'`)
		_, _ = s.db.Exec(`UPDATE projects SET sort_by = 'manual', sort_order = 'asc' WHERE id = 'inbox' AND (sort_by = '' OR sort_by IS NULL)`)
	}

	// Rescue any projects that were accidentally nested under inbox or orphaned
	_, _ = s.db.Exec(`UPDATE projects SET parent_id = NULL WHERE parent_id = 'inbox'`)

	return nil
}

// ----------------------------------------------------------------------
// Projects
// ----------------------------------------------------------------------

func (s *Store) ListProjects() ([]*Project, error) {
	rows, err := s.db.Query(`
		SELECT id, parent_id, name, icon, position, sort_by, sort_order, created_at
		FROM projects
		WHERE id != 'inbox'
		ORDER BY position ASC, created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var all []*Project
	projectMap := make(map[string]*Project)

	for rows.Next() {
		p := &Project{}
		var parentID sql.NullString
		if err := rows.Scan(&p.ID, &parentID, &p.Name, &p.Icon, &p.Position, &p.SortBy, &p.SortOrder, &p.CreatedAt); err != nil {
			return nil, err
		}
		if parentID.Valid && parentID.String != "inbox" && parentID.String != "" {
			p.ParentID = &parentID.String
		}
		if p.SortBy == "" {
			p.SortBy = "manual"
		}
		if p.SortOrder == "" {
			p.SortOrder = "asc"
		}
		p.Children = make([]*Project, 0)
		projectMap[p.ID] = p
		all = append(all, p)
	}

	roots := make([]*Project, 0)
	for _, p := range all {
		if p.ParentID == nil || *p.ParentID == "" || *p.ParentID == "inbox" {
			p.ParentID = nil
			roots = append(roots, p)
		} else if parent, exists := projectMap[*p.ParentID]; exists {
			parent.Children = append(parent.Children, p)
		} else {
			p.ParentID = nil
			roots = append(roots, p)
		}
	}

	return roots, nil
}

func (s *Store) GetProject(id string) (*Project, error) {
	p := &Project{}
	var parentID sql.NullString
	err := s.db.QueryRow(`
		SELECT id, parent_id, name, icon, position, sort_by, sort_order, created_at
		FROM projects
		WHERE id = ?
	`, id).Scan(&p.ID, &parentID, &p.Name, &p.Icon, &p.Position, &p.SortBy, &p.SortOrder, &p.CreatedAt)
	if err != nil {
		if id == "inbox" {
			return &Project{ID: "inbox", Name: "Inbox", SortBy: "manual", SortOrder: "asc"}, nil
		}
		return nil, err
	}
	if parentID.Valid && parentID.String != "inbox" && parentID.String != "" {
		p.ParentID = &parentID.String
	}
	if p.SortBy == "" {
		p.SortBy = "manual"
	}
	if p.SortOrder == "" {
		p.SortOrder = "asc"
	}
	return p, nil
}

func (s *Store) CreateProject(p *Project) error {
	if p.ID == "" {
		p.ID = uuid.New().String()
	}
	if p.SortBy == "" {
		p.SortBy = "manual"
	}
	if p.SortOrder == "" {
		p.SortOrder = "asc"
	}
	p.CreatedAt = time.Now()

	_, err := s.db.Exec(`
		INSERT INTO projects (id, parent_id, name, icon, position, sort_by, sort_order, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, p.ID, p.ParentID, p.Name, p.Icon, p.Position, p.SortBy, p.SortOrder, p.CreatedAt)
	return err
}

func (s *Store) UpdateProject(p *Project) error {
	if p.SortBy == "" {
		p.SortBy = "manual"
	}
	if p.SortOrder == "" {
		p.SortOrder = "asc"
	}
	_, err := s.db.Exec(`
		UPDATE projects
		SET parent_id = ?, name = ?, icon = ?, position = ?, sort_by = ?, sort_order = ?
		WHERE id = ?
	`, p.ParentID, p.Name, p.Icon, p.Position, p.SortBy, p.SortOrder, p.ID)
	return err
}

func (s *Store) UpdateProjectSort(id string, sortBy, sortOrder string) error {
	if sortBy == "" {
		sortBy = "manual"
	}
	if sortOrder == "" {
		sortOrder = "asc"
	}
	res, err := s.db.Exec(`UPDATE projects SET sort_by = ?, sort_order = ? WHERE id = ?`, sortBy, sortOrder, id)
	if err != nil {
		return err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 && id == "inbox" {
		_, err = s.db.Exec(`
			INSERT INTO projects (id, parent_id, name, icon, position, sort_by, sort_order)
			VALUES ('inbox', NULL, 'Inbox', '', 0, ?, ?)
		`, sortBy, sortOrder)
		return err
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) DeleteProject(id string) error {
	if id == "inbox" {
		return fmt.Errorf("cannot delete default inbox project")
	}
	_, err := s.db.Exec("DELETE FROM projects WHERE id = ?", id)
	return err
}

type ReorderProjectItem struct {
	ID       string  `json:"id"`
	Position int     `json:"position"`
	ParentID *string `json:"parent_id"`
}

func (s *Store) ReorderProjects(items []ReorderProjectItem) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`UPDATE projects SET position = ?, parent_id = ? WHERE id = ?`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, it := range items {
		if it.ID == "inbox" {
			continue
		}
		if it.ParentID != nil && (*it.ParentID == "inbox" || *it.ParentID == "") {
			it.ParentID = nil
		}
		if _, err := stmt.Exec(it.Position, it.ParentID, it.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ----------------------------------------------------------------------
// Sections
// ----------------------------------------------------------------------

func (s *Store) ListSections(projectID string) ([]*Section, error) {
	rows, err := s.db.Query(`
		SELECT id, project_id, name, position, created_at
		FROM sections
		WHERE project_id = ?
		ORDER BY position ASC, created_at ASC
	`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sections := make([]*Section, 0)
	for rows.Next() {
		sec := &Section{}
		if err := rows.Scan(&sec.ID, &sec.ProjectID, &sec.Name, &sec.Position, &sec.CreatedAt); err != nil {
			return nil, err
		}
		sections = append(sections, sec)
	}
	return sections, nil
}

func (s *Store) CreateSection(sec *Section) error {
	if sec.ID == "" {
		sec.ID = uuid.New().String()
	}
	sec.CreatedAt = time.Now()

	if sec.Position <= 0 {
		var maxPos sql.NullInt64
		_ = s.db.QueryRow("SELECT MAX(position) FROM sections WHERE project_id = ?", sec.ProjectID).Scan(&maxPos)
		if maxPos.Valid {
			sec.Position = int(maxPos.Int64) + 1
		} else {
			sec.Position = 1
		}
	}

	_, err := s.db.Exec(`
		INSERT INTO sections (id, project_id, name, position, created_at)
		VALUES (?, ?, ?, ?, ?)
	`, sec.ID, sec.ProjectID, sec.Name, sec.Position, sec.CreatedAt)
	return err
}

func (s *Store) UpdateSection(sec *Section) error {
	_, err := s.db.Exec(`
		UPDATE sections
		SET name = ?, position = ?
		WHERE id = ?
	`, sec.Name, sec.Position, sec.ID)
	return err
}

func (s *Store) DeleteSection(id string) error {
	return s.RunInTx(func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM tasks WHERE section_id = ?", id); err != nil {
			return err
		}
		_, err := tx.Exec("DELETE FROM sections WHERE id = ?", id)
		return err
	})
}

// ----------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------

type TaskFilter struct {
	View      string // "inbox", "upcoming", "project", "all"
	ProjectID string
	SectionID string
	SortBy    string // "priority", "date", "title", "position"
	SortOrder string // "asc", "desc"
	Now       time.Time
}

func (s *Store) ListTasks(filter TaskFilter) ([]*Task, error) {
	if filter.Now.IsZero() {
		filter.Now = time.Now()
	}

	upcomingStr := filter.Now.AddDate(0, 0, 7).Format("2006-01-02")

	var query strings.Builder
	var args []interface{}

	query.WriteString(`
		SELECT t.id, t.project_id, t.section_id, t.parent_id, t.title, t.description,
		       t.priority, t.due_date, t.recurrence, t.location,
		       t.position, t.is_collapsed, t.created_at, t.updated_at,
		       COALESCE(p.name, '') as project_name
		FROM tasks t
		LEFT JOIN projects p ON t.project_id = p.id
	`)

	var whereClauses []string

	switch filter.View {
	case "inbox":
		whereClauses = append(whereClauses, "t.project_id = 'inbox'")
	case "upcoming":
		whereClauses = append(whereClauses, "t.due_date IS NOT NULL AND substr(t.due_date, 1, 10) <= ?")
		args = append(args, upcomingStr)
	case "project":
		if filter.ProjectID != "" {
			whereClauses = append(whereClauses, "t.project_id = ?")
			args = append(args, filter.ProjectID)
		}
	}

	if filter.SectionID != "" {
		whereClauses = append(whereClauses, "t.section_id = ?")
		args = append(args, filter.SectionID)
	}

	if len(whereClauses) > 0 {
		query.WriteString(" WHERE " + strings.Join(whereClauses, " AND "))
	}

	// Sorting
	order := "ASC"
	if strings.ToUpper(filter.SortOrder) == "DESC" {
		order = "DESC"
	}

	switch filter.SortBy {
	case "priority":
		query.WriteString(fmt.Sprintf(" ORDER BY t.priority %s, t.position ASC", order))
	case "date":
		query.WriteString(fmt.Sprintf(" ORDER BY (t.due_date IS NULL) ASC, t.due_date %s, t.priority ASC", order))
	case "title":
		query.WriteString(fmt.Sprintf(" ORDER BY t.title %s", order))
	default:
		// Manual position order
		query.WriteString(" ORDER BY t.position ASC, t.created_at ASC")
	}

	rows, err := s.db.Query(query.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var all []*Task
	taskMap := make(map[string]*Task)

	for rows.Next() {
		t := &Task{}
		var sectionID, parentID, dueDate, recurrence, location sql.NullString
		var isCollapsed int

		err := rows.Scan(
			&t.ID, &t.ProjectID, &sectionID, &parentID, &t.Title, &t.Description,
			&t.Priority, &dueDate, &recurrence, &location,
			&t.Position, &isCollapsed, &t.CreatedAt, &t.UpdatedAt,
			&t.ProjectName,
		)
		if err != nil {
			return nil, err
		}

		if sectionID.Valid {
			t.SectionID = &sectionID.String
		}
		if parentID.Valid {
			t.ParentID = &parentID.String
		}
		if dueDate.Valid {
			t.DueDate = &dueDate.String
		}
		if recurrence.Valid {
			t.Recurrence = &recurrence.String
		}
		if location.Valid {
			t.Location = &location.String
		}
		t.IsCollapsed = isCollapsed == 1
		t.Subtasks = make([]*Task, 0)

		taskMap[t.ID] = t
		all = append(all, t)
	}

	roots := make([]*Task, 0)
	for _, t := range all {
		if t.ParentID == nil || *t.ParentID == "" {
			roots = append(roots, t)
		} else if parent, exists := taskMap[*t.ParentID]; exists {
			parent.Subtasks = append(parent.Subtasks, t)
		} else {
			roots = append(roots, t)
		}
	}

	return roots, nil
}

func (s *Store) ListProjectTasksForExport(projectID string) ([]*Task, error) {
	rows, err := s.db.Query(`
		SELECT id, project_id, section_id, parent_id, title, description,
		       priority, due_date, recurrence, location, position, created_at, updated_at
		FROM tasks
		WHERE project_id = ?
		ORDER BY position ASC, created_at ASC
	`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []*Task
	for rows.Next() {
		t := &Task{}
		var sec, par, due, rec, loc sql.NullString
		if err := rows.Scan(
			&t.ID, &t.ProjectID, &sec, &par, &t.Title, &t.Description,
			&t.Priority, &due, &rec, &loc,
			&t.Position, &t.CreatedAt, &t.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if sec.Valid {
			t.SectionID = &sec.String
		}
		if par.Valid {
			t.ParentID = &par.String
		}
		if due.Valid {
			t.DueDate = &due.String
		}
		if rec.Valid {
			t.Recurrence = &rec.String
		}
		if loc.Valid {
			t.Location = &loc.String
		}
		tasks = append(tasks, t)
	}
	return tasks, nil
}

func (s *Store) GetTask(id string) (*Task, error) {
	row := s.db.QueryRow(`
		SELECT t.id, t.project_id, t.section_id, t.parent_id, t.title, t.description,
		       t.priority, t.due_date, t.recurrence, t.location,
		       t.position, t.is_collapsed, t.created_at, t.updated_at,
		       COALESCE(p.name, '') as project_name
		FROM tasks t
		LEFT JOIN projects p ON t.project_id = p.id
		WHERE t.id = ?
	`, id)

	t := &Task{}
	var sectionID, parentID, dueDate, recurrence, location sql.NullString
	var isCollapsed int

	err := row.Scan(
		&t.ID, &t.ProjectID, &sectionID, &parentID, &t.Title, &t.Description,
		&t.Priority, &dueDate, &recurrence, &location,
		&t.Position, &isCollapsed, &t.CreatedAt, &t.UpdatedAt,
		&t.ProjectName,
	)
	if err != nil {
		return nil, err
	}

	if sectionID.Valid {
		t.SectionID = &sectionID.String
	}
	if parentID.Valid {
		t.ParentID = &parentID.String
	}
	if dueDate.Valid {
		t.DueDate = &dueDate.String
	}
	if recurrence.Valid {
		t.Recurrence = &recurrence.String
	}
	if location.Valid {
		t.Location = &location.String
	}
	t.IsCollapsed = isCollapsed == 1

	subs, err := s.loadSubtasks(t.ID)
	if err == nil {
		t.Subtasks = subs
	} else {
		t.Subtasks = make([]*Task, 0)
	}

	return t, nil
}

func (s *Store) loadSubtasks(parentID string) ([]*Task, error) {
	rows, err := s.db.Query(`
		SELECT t.id, t.project_id, t.section_id, t.parent_id, t.title, t.description,
		       t.priority, t.due_date, t.recurrence, t.location,
		       t.position, t.is_collapsed, t.created_at, t.updated_at,
		       COALESCE(p.name, '') as project_name
		FROM tasks t
		LEFT JOIN projects p ON t.project_id = p.id
		WHERE t.parent_id = ?
		ORDER BY t.position ASC, t.created_at ASC
	`, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	subtasks := make([]*Task, 0)
	for rows.Next() {
		st := &Task{}
		var sec, par, due, rec, loc sql.NullString
		var col int
		if err := rows.Scan(
			&st.ID, &st.ProjectID, &sec, &par, &st.Title, &st.Description,
			&st.Priority, &due, &rec, &loc,
			&st.Position, &col, &st.CreatedAt, &st.UpdatedAt,
			&st.ProjectName,
		); err != nil {
			return nil, err
		}
		if sec.Valid {
			st.SectionID = &sec.String
		}
		if par.Valid {
			st.ParentID = &par.String
		}
		if due.Valid {
			st.DueDate = &due.String
		}
		if rec.Valid {
			st.Recurrence = &rec.String
		}
		if loc.Valid {
			st.Location = &loc.String
		}
		st.IsCollapsed = col == 1
		children, err := s.loadSubtasks(st.ID)
		if err == nil {
			st.Subtasks = children
		} else {
			st.Subtasks = make([]*Task, 0)
		}
		subtasks = append(subtasks, st)
	}
	return subtasks, nil
}

func (s *Store) CreateTask(t *Task) error {
	if t.ID == "" {
		t.ID = uuid.New().String()
	}
	if t.ProjectID == "" {
		t.ProjectID = "inbox"
	}
	if t.Priority <= 0 || t.Priority > 3 {
		t.Priority = 3
	}
	t.CreatedAt = time.Now()
	t.UpdatedAt = time.Now()

	if t.Position == 0 {
		var maxPos sql.NullInt64
		if t.ParentID != nil && *t.ParentID != "" {
			_ = s.db.QueryRow("SELECT MAX(position) FROM tasks WHERE parent_id = ?", *t.ParentID).Scan(&maxPos)
		} else if t.SectionID != nil && *t.SectionID != "" {
			_ = s.db.QueryRow("SELECT MAX(position) FROM tasks WHERE project_id = ? AND section_id = ? AND parent_id IS NULL", t.ProjectID, *t.SectionID).Scan(&maxPos)
		} else {
			_ = s.db.QueryRow("SELECT MAX(position) FROM tasks WHERE project_id = ? AND section_id IS NULL AND parent_id IS NULL", t.ProjectID).Scan(&maxPos)
		}
		if maxPos.Valid {
			t.Position = int(maxPos.Int64) + 1
		} else {
			t.Position = 1
		}
	}

	isCollapsed := 0
	if t.IsCollapsed {
		isCollapsed = 1
	}

	_, err := s.db.Exec(`
		INSERT INTO tasks (
			id, project_id, section_id, parent_id, title, description,
			priority, due_date, recurrence, location,
			position, is_collapsed, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, t.ID, t.ProjectID, t.SectionID, t.ParentID, t.Title, t.Description,
		t.Priority, t.DueDate, t.Recurrence, t.Location,
		t.Position, isCollapsed, t.CreatedAt, t.UpdatedAt)

	return err
}

func (s *Store) UpdateTask(t *Task) error {
	t.UpdatedAt = time.Now()
	isCollapsed := 0
	if t.IsCollapsed {
		isCollapsed = 1
	}

	_, err := s.db.Exec(`
		UPDATE tasks
		SET project_id = ?, section_id = ?, parent_id = ?, title = ?, description = ?,
		    priority = ?, due_date = ?, recurrence = ?, location = ?,
		    position = ?, is_collapsed = ?, updated_at = ?
		WHERE id = ?
	`, t.ProjectID, t.SectionID, t.ParentID, t.Title, t.Description,
		t.Priority, t.DueDate, t.Recurrence, t.Location,
		t.Position, isCollapsed, t.UpdatedAt, t.ID)

	return err
}

func (s *Store) DeleteTask(id string) error {
	_, err := s.db.Exec("DELETE FROM tasks WHERE id = ?", id)
	return err
}

func (s *Store) CompleteTask(id string, nextDateCalculator func(string, string, time.Time) string, now time.Time) (*Task, bool, error) {
	task, err := s.GetTask(id)
	if err != nil {
		return nil, false, err
	}

	if task.Recurrence != nil && *task.Recurrence != "" {
		currentDue := ""
		if task.DueDate != nil {
			currentDue = *task.DueDate
		}
		nextDate := nextDateCalculator(currentDue, *task.Recurrence, now)
		task.DueDate = &nextDate
		task.UpdatedAt = now

		_, err := s.db.Exec(`
			UPDATE tasks
			SET due_date = ?, updated_at = ?
			WHERE id = ?
		`, nextDate, task.UpdatedAt, task.ID)
		if err != nil {
			return nil, false, err
		}
		return task, false, nil
	}

	if err := s.DeleteTask(id); err != nil {
		return nil, false, err
	}
	return task, true, nil
}

type RestoreUpdate struct {
	ID      string  `json:"id"`
	DueDate *string `json:"due_date"`
}

// RestoreTasks restores deleted tasks and reverts recurring task updates inside a transaction.
func (s *Store) RestoreTasks(tasks []*Task, updates []RestoreUpdate) error {
	return s.RunInTx(func(tx *sql.Tx) error {
		now := time.Now()

		for _, u := range updates {
			_, err := tx.Exec(`
				UPDATE tasks
				SET due_date = ?, updated_at = ?
				WHERE id = ?
			`, u.DueDate, now, u.ID)
			if err != nil {
				return err
			}
		}

		var insertTree func(t *Task) error
		insertTree = func(t *Task) error {
			if t.ID == "" {
				t.ID = uuid.New().String()
			}
			if t.ProjectID == "" {
				t.ProjectID = "inbox"
			}
			if t.Priority <= 0 || t.Priority > 3 {
				t.Priority = 3
			}
			isCollapsed := 0
			if t.IsCollapsed {
				isCollapsed = 1
			}
			createdAt := t.CreatedAt
			if createdAt.IsZero() {
				createdAt = now
			}

			if t.Position == 0 {
				var maxPos sql.NullInt64
				if t.ParentID != nil && *t.ParentID != "" {
					_ = tx.QueryRow("SELECT MAX(position) FROM tasks WHERE parent_id = ?", *t.ParentID).Scan(&maxPos)
				} else if t.SectionID != nil && *t.SectionID != "" {
					_ = tx.QueryRow("SELECT MAX(position) FROM tasks WHERE project_id = ? AND section_id = ? AND parent_id IS NULL", t.ProjectID, *t.SectionID).Scan(&maxPos)
				} else {
					_ = tx.QueryRow("SELECT MAX(position) FROM tasks WHERE project_id = ? AND section_id IS NULL AND parent_id IS NULL", t.ProjectID).Scan(&maxPos)
				}
				if maxPos.Valid {
					t.Position = int(maxPos.Int64) + 1
				} else {
					t.Position = 1
				}
			}

			// Clean up any existing row with this ID just in case
			_, _ = tx.Exec("DELETE FROM tasks WHERE id = ?", t.ID)

			_, err := tx.Exec(`
				INSERT INTO tasks (
					id, project_id, section_id, parent_id, title, description,
					priority, due_date, recurrence, location,
					position, is_collapsed, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`, t.ID, t.ProjectID, t.SectionID, t.ParentID, t.Title, t.Description,
				t.Priority, t.DueDate, t.Recurrence, t.Location,
				t.Position, isCollapsed, createdAt, now)
			if err != nil {
				return err
			}

			for _, sub := range t.Subtasks {
				sub.ParentID = &t.ID
				sub.ProjectID = t.ProjectID
				if err := insertTree(sub); err != nil {
					return err
				}
			}
			return nil
		}

		for _, t := range tasks {
			if err := insertTree(t); err != nil {
				return err
			}
		}

		return nil
	})
}

func shiftDueDate(dueStr string, days int) (string, error) {
	parts := strings.SplitN(strings.TrimSpace(dueStr), " ", 2)
	datePart := parts[0]
	t, err := time.Parse("2006-01-02", datePart)
	if err != nil {
		return "", err
	}
	shifted := t.AddDate(0, 0, days)
	res := shifted.Format("2006-01-02")
	if len(parts) > 1 && strings.TrimSpace(parts[1]) != "" {
		res += " " + strings.TrimSpace(parts[1])
	}
	return res, nil
}

func shiftDescendantsDueDateTx(tx *sql.Tx, parentID string, days int, now time.Time) error {
	rows, err := tx.Query(`
		WITH RECURSIVE descendants(id, due_date) AS (
			SELECT id, due_date FROM tasks WHERE parent_id = ?
			UNION ALL
			SELECT t.id, t.due_date FROM tasks t JOIN descendants d ON t.parent_id = d.id
		)
		SELECT id, due_date FROM descendants WHERE due_date IS NOT NULL AND due_date != ''
	`, parentID)
	if err != nil {
		return err
	}
	defer rows.Close()

	type item struct {
		id      string
		dueDate string
	}
	var items []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.dueDate); err != nil {
			return err
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()

	if len(items) == 0 {
		return nil
	}

	stmt, err := tx.Prepare(`UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, it := range items {
		shifted, err := shiftDueDate(it.dueDate, days)
		if err != nil {
			continue
		}
		if _, err := stmt.Exec(shifted, now, it.id); err != nil {
			return err
		}
	}
	return nil
}

func cascadeProjectAndSectionTx(tx *sql.Tx, parentID string, projectID string, sectionID *string, now time.Time) error {
	var secID *string
	if sectionID != nil && *sectionID != "" {
		secID = sectionID
	}
	_, err := tx.Exec(`
		WITH RECURSIVE descendants(id) AS (
			SELECT id FROM tasks WHERE parent_id = ?
			UNION ALL
			SELECT t.id FROM tasks t JOIN descendants d ON t.parent_id = d.id
		)
		UPDATE tasks
		SET project_id = ?, section_id = ?, updated_at = ?
		WHERE id IN (SELECT id FROM descendants)
	`, parentID, projectID, secID, now)
	return err
}

func (s *Store) PostponeTask(id string, days int, now time.Time) error {
	task, err := s.GetTask(id)
	if err != nil {
		return err
	}

	base := now
	if task.DueDate != nil && *task.DueDate != "" {
		if t, err := time.Parse("2006-01-02", strings.Split(*task.DueDate, " ")[0]); err == nil {
			today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
			if t.After(today) {
				base = t
			}
		}
	}

	target := base.AddDate(0, 0, days)
	targetStr := target.Format("2006-01-02")
	if task.DueDate != nil && strings.Contains(*task.DueDate, " ") {
		parts := strings.SplitN(*task.DueDate, " ", 2)
		targetStr += " " + parts[1]
	}

	return s.RunInTx(func(tx *sql.Tx) error {
		nowTime := time.Now()
		_, err := tx.Exec(`
			UPDATE tasks
			SET due_date = ?, updated_at = ?
			WHERE id = ?
		`, targetStr, nowTime, id)
		if err != nil {
			return err
		}

		if days != 0 {
			if err := shiftDescendantsDueDateTx(tx, id, days, nowTime); err != nil {
				return err
			}
		}

		return nil
	})
}

type ReorderTaskItem struct {
	ID        string  `json:"id"`
	Position  int     `json:"position"`
	ParentID  *string `json:"parent_id"`
	SectionID *string `json:"section_id"`
	ProjectID *string `json:"project_id"`
}

func (s *Store) ReorderTasks(items []ReorderTaskItem) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	type changedItem struct {
		id        string
		projectID string
		sectionID *string
	}
	var changed []changedItem

	for _, it := range items {
		var currProj string
		var currSec sql.NullString
		err := tx.QueryRow("SELECT project_id, section_id FROM tasks WHERE id = ?", it.ID).Scan(&currProj, &currSec)
		if err != nil {
			continue
		}

		targetProj := currProj
		if it.ProjectID != nil && *it.ProjectID != "" {
			targetProj = *it.ProjectID
		} else if it.ParentID != nil && *it.ParentID != "" {
			var pProj string
			if err := tx.QueryRow("SELECT project_id FROM tasks WHERE id = ?", *it.ParentID).Scan(&pProj); err == nil && pProj != "" {
				targetProj = pProj
			}
		}

		var targetSec *string
		if it.SectionID != nil && *it.SectionID != "" {
			targetSec = it.SectionID
		}

		projChanged := (currProj != targetProj)
		secChanged := false
		if !currSec.Valid {
			if targetSec != nil {
				secChanged = true
			}
		} else {
			if targetSec == nil {
				secChanged = true
			} else if currSec.String != *targetSec {
				secChanged = true
			}
		}

		if projChanged || secChanged {
			changed = append(changed, changedItem{
				id:        it.ID,
				projectID: targetProj,
				sectionID: targetSec,
			})
		}
	}

	stmt, err := tx.Prepare(`
		UPDATE tasks
		SET position = ?, parent_id = ?, section_id = ?, project_id = COALESCE(?, project_id), updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, it := range items {
		var secID *string
		if it.SectionID != nil && *it.SectionID != "" {
			secID = it.SectionID
		}
		var projID *string
		if it.ProjectID != nil && *it.ProjectID != "" {
			projID = it.ProjectID
		} else if it.ParentID != nil && *it.ParentID != "" {
			for _, ch := range changed {
				if ch.id == it.ID {
					projID = &ch.projectID
					break
				}
			}
		}
		if _, err := stmt.Exec(it.Position, it.ParentID, secID, projID, it.ID); err != nil {
			return err
		}
	}

	now := time.Now()
	for _, ch := range changed {
		var finalProj string
		var finalSec sql.NullString
		if err := tx.QueryRow("SELECT project_id, section_id FROM tasks WHERE id = ?", ch.id).Scan(&finalProj, &finalSec); err != nil {
			finalProj = ch.projectID
			if ch.sectionID != nil {
				finalSec = sql.NullString{String: *ch.sectionID, Valid: true}
			}
		}
		var finalSecPtr *string
		if finalSec.Valid && finalSec.String != "" {
			finalSecPtr = &finalSec.String
		}
		if err := cascadeProjectAndSectionTx(tx, ch.id, finalProj, finalSecPtr, now); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *Store) IndentTask(id string, siblingID string) error {
	_, err := s.db.Exec(`
		UPDATE tasks
		SET parent_id = ?, updated_at = ?
		WHERE id = ?
	`, siblingID, time.Now(), id)
	return err
}

func (s *Store) OutdentTask(id string) error {
	task, err := s.GetTask(id)
	if err != nil {
		return err
	}
	if task.ParentID == nil {
		return nil
	}

	parent, err := s.GetTask(*task.ParentID)
	if err != nil {
		_, err := s.db.Exec("UPDATE tasks SET parent_id = NULL WHERE id = ?", id)
		return err
	}

	_, err = s.db.Exec(`
		UPDATE tasks
		SET parent_id = ?, updated_at = ?
		WHERE id = ?
	`, parent.ParentID, time.Now(), id)
	return err
}

// MoveSection moves a section and all tasks within it to another project or position.
func (s *Store) MoveSection(sectionID string, targetProjectID string, targetPosition int) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec(`
		UPDATE sections
		SET project_id = ?, position = ?
		WHERE id = ?
	`, targetProjectID, targetPosition, sectionID)
	if err != nil {
		return err
	}

	_, err = tx.Exec(`
		UPDATE tasks
		SET project_id = ?, updated_at = CURRENT_TIMESTAMP
		WHERE section_id = ?
	`, targetProjectID, sectionID)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// PatchTask updates only the provided fields of a task without overwriting existing data.
func (s *Store) PatchTask(id string, updates map[string]interface{}) (*Task, error) {
	task, err := s.GetTask(id)
	if err != nil {
		return nil, err
	}

	var oldDue *string
	if task.DueDate != nil && strings.TrimSpace(*task.DueDate) != "" {
		s := strings.TrimSpace(*task.DueDate)
		oldDue = &s
	}

	if v, ok := updates["title"]; ok {
		if str, ok := v.(string); ok && strings.TrimSpace(str) != "" {
			task.Title = strings.TrimSpace(str)
		}
	}
	if v, ok := updates["description"]; ok {
		if str, ok := v.(string); ok {
			task.Description = str
		}
	}
	projectIdUpdated := false
	if v, ok := updates["project_id"]; ok {
		if str, ok := v.(string); ok && strings.TrimSpace(str) != "" {
			task.ProjectID = strings.TrimSpace(str)
			projectIdUpdated = true
		}
	}
	sectionIdUpdated := false
	if v, ok := updates["section_id"]; ok {
		sectionIdUpdated = true
		if v == nil {
			task.SectionID = nil
		} else if str, ok := v.(string); ok {
			if strings.TrimSpace(str) == "" {
				task.SectionID = nil
			} else {
				trimmed := strings.TrimSpace(str)
				task.SectionID = &trimmed
			}
		}
	}
	if v, ok := updates["parent_id"]; ok {
		if v == nil {
			task.ParentID = nil
		} else if str, ok := v.(string); ok {
			if strings.TrimSpace(str) == "" {
				task.ParentID = nil
			} else {
				trimmed := strings.TrimSpace(str)
				task.ParentID = &trimmed
				if !projectIdUpdated {
					var parentProj string
					var parentSec sql.NullString
					if err := s.db.QueryRow("SELECT project_id, section_id FROM tasks WHERE id = ?", trimmed).Scan(&parentProj, &parentSec); err == nil && parentProj != "" {
						task.ProjectID = parentProj
						projectIdUpdated = true
						if !sectionIdUpdated {
							sectionIdUpdated = true
							if parentSec.Valid && parentSec.String != "" {
								task.SectionID = &parentSec.String
							} else {
								task.SectionID = nil
							}
						}
					}
				}
			}
		}
	}
	if v, ok := updates["priority"]; ok {
		switch num := v.(type) {
		case float64:
			if num >= 1 && num <= 4 {
				task.Priority = int(num)
			}
		case int:
			if num >= 1 && num <= 4 {
				task.Priority = num
			}
		}
	}
	dueDateUpdated := false
	if v, ok := updates["due_date"]; ok {
		dueDateUpdated = true
		if v == nil {
			task.DueDate = nil
		} else if str, ok := v.(string); ok {
			trimmed := strings.TrimSpace(str)
			if trimmed == "" {
				task.DueDate = nil
			} else {
				task.DueDate = &trimmed
			}
		}
	}
	if v, ok := updates["recurrence"]; ok {
		if v == nil {
			task.Recurrence = nil
		} else if str, ok := v.(string); ok {
			trimmed := strings.TrimSpace(str)
			if trimmed == "" {
				task.Recurrence = nil
			} else {
				task.Recurrence = &trimmed
			}
		}
	}
	if v, ok := updates["location"]; ok {
		if v == nil {
			task.Location = nil
		} else if str, ok := v.(string); ok {
			trimmed := strings.TrimSpace(str)
			if trimmed == "" {
				task.Location = nil
			} else {
				task.Location = &trimmed
			}
		}
	}
	if v, ok := updates["position"]; ok {
		switch num := v.(type) {
		case float64:
			task.Position = int(num)
		case int:
			task.Position = num
		}
	}

	deltaDays := 0
	hasDelta := false
	if dueDateUpdated && oldDue != nil && task.DueDate != nil {
		oldDateStr := strings.Split(*oldDue, " ")[0]
		newDateStr := strings.Split(*task.DueDate, " ")[0]
		tOld, errOld := time.Parse("2006-01-02", oldDateStr)
		tNew, errNew := time.Parse("2006-01-02", newDateStr)
		if errOld == nil && errNew == nil {
			deltaDays = int(math.Round(float64(tNew.Sub(tOld)) / float64(24*time.Hour)))
			if deltaDays != 0 {
				hasDelta = true
			}
		}
	}

	nowTime := time.Now()
	task.UpdatedAt = nowTime
	isCollapsed := 0
	if task.IsCollapsed {
		isCollapsed = 1
	}

	err = s.RunInTx(func(tx *sql.Tx) error {
		_, err := tx.Exec(`
			UPDATE tasks
			SET project_id = ?, section_id = ?, parent_id = ?, title = ?, description = ?,
			    priority = ?, due_date = ?, recurrence = ?, location = ?,
			    position = ?, is_collapsed = ?, updated_at = ?
			WHERE id = ?
		`, task.ProjectID, task.SectionID, task.ParentID, task.Title, task.Description,
			task.Priority, task.DueDate, task.Recurrence, task.Location,
			task.Position, isCollapsed, task.UpdatedAt, task.ID)
		if err != nil {
			return err
		}

		if projectIdUpdated || sectionIdUpdated {
			if err := cascadeProjectAndSectionTx(tx, task.ID, task.ProjectID, task.SectionID, nowTime); err != nil {
				return err
			}
		}

		if hasDelta {
			if err := shiftDescendantsDueDateTx(tx, task.ID, deltaDays, nowTime); err != nil {
				return err
			}
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	refreshed, err := s.GetTask(id)
	if err == nil {
		return refreshed, nil
	}
	return task, nil
}

// SearchTasks performs a fast global search across all tasks titles, descriptions, and locations.
func (s *Store) SearchTasks(query string) ([]*Task, error) {
	pattern := "%" + query + "%"
	rows, err := s.db.Query(`
		SELECT t.id, t.project_id, t.section_id, t.parent_id, t.title, t.description,
		       t.priority, t.due_date, t.recurrence, t.location,
		       t.position, t.is_collapsed, t.created_at, t.updated_at,
		       COALESCE(p.name, '') as project_name
		FROM tasks t
		LEFT JOIN projects p ON t.project_id = p.id
		WHERE t.title LIKE ? OR t.description LIKE ? OR t.location LIKE ?
		ORDER BY t.priority ASC, t.created_at DESC
		LIMIT 50
	`, pattern, pattern, pattern)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]*Task, 0)
	for rows.Next() {
		t := &Task{}
		var sectionID, parentID, dueDate, recurrence, location sql.NullString
		var isCollapsed int

		err := rows.Scan(
			&t.ID, &t.ProjectID, &sectionID, &parentID, &t.Title, &t.Description,
			&t.Priority, &dueDate, &recurrence, &location,
			&t.Position, &isCollapsed, &t.CreatedAt, &t.UpdatedAt,
			&t.ProjectName,
		)
		if err != nil {
			return nil, err
		}
		if sectionID.Valid { t.SectionID = &sectionID.String }
		if parentID.Valid { t.ParentID = &parentID.String }
		if dueDate.Valid { t.DueDate = &dueDate.String }
		if recurrence.Valid { t.Recurrence = &recurrence.String }
		if location.Valid { t.Location = &location.String }
		results = append(results, t)
	}
	return results, nil
}

// ----------------------------------------------------------------------
// Authentication & Sessions
// ----------------------------------------------------------------------

func hashPassword(password string, salt []byte) string {
	h := hmac.New(sha256.New, []byte(password))
	h.Write(salt)
	u := h.Sum(nil)
	t := make([]byte, len(u))
	copy(t, u)

	for iter := 1; iter < 100000; iter++ {
		h.Reset()
		h.Write(u)
		u = h.Sum(nil)
		for i := 0; i < len(t); i++ {
			t[i] ^= u[i]
		}
	}
	return hex.EncodeToString(salt) + "$" + hex.EncodeToString(t)
}

func verifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 2 {
		return false
	}
	salt, err := hex.DecodeString(parts[0])
	if err != nil {
		return false
	}
	expectedHash := hashPassword(password, salt)
	return subtle.ConstantTimeCompare([]byte(stored), []byte(expectedHash)) == 1
}

func (s *Store) HasPassword() (bool, error) {
	var count int
	err := s.db.QueryRow("SELECT COUNT(*) FROM auth_settings WHERE key = 'password_hash'").Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (s *Store) SetPassword(password string) error {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	hashed := hashPassword(password, salt)
	_, err := s.db.Exec(`
		INSERT INTO auth_settings (key, value) VALUES ('password_hash', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`, hashed)
	return err
}

func (s *Store) VerifyPassword(password string) (bool, error) {
	var stored string
	err := s.db.QueryRow("SELECT value FROM auth_settings WHERE key = 'password_hash'").Scan(&stored)
	if err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	return verifyPassword(password, stored), nil
}

func (s *Store) CreateSession() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	_, err := s.db.Exec("INSERT INTO auth_sessions (token) VALUES (?)", token)
	if err != nil {
		return "", err
	}
	return token, nil
}

func (s *Store) ValidateSession(token string) bool {
	if token == "" {
		return false
	}
	var count int
	err := s.db.QueryRow("SELECT COUNT(*) FROM auth_sessions WHERE token = ?", token).Scan(&count)
	return err == nil && count > 0
}

func (s *Store) DeleteSession(token string) error {
	_, err := s.db.Exec("DELETE FROM auth_sessions WHERE token = ?", token)
	return err
}

func (s *Store) DeleteAllSessions() error {
	_, err := s.db.Exec("DELETE FROM auth_sessions")
	return err
}


