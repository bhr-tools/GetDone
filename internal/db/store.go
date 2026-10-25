// Package db persists projects, sections, tasks and authentication data in a
// single SQLite file.
package db

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

// InboxID is the fixed id of the default project. It always exists, cannot be
// deleted and is not listed among the user's projects.
const InboxID = "inbox"

// ErrNotFound is returned when the requested row does not exist.
var ErrNotFound = errors.New("not found")

// ValidationError reports rejected input. Its message is meant for the user.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, args ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// Store is safe for concurrent use.
type Store struct {
	db *sql.DB
}

// querier is implemented by both *sql.DB and *sql.Tx.
type querier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// Open opens (creating it if needed) the database at path and migrates it.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	dsn := path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	// A single connection serializes every statement. For a personal task
	// manager this costs nothing and rules out "database is locked" errors.
	sqlDB.SetMaxOpenConns(1)

	s := &Store{db: sqlDB}
	if err := s.migrate(); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

// Ping checks that the database answers.
func (s *Store) Ping() error {
	return s.db.Ping()
}

// tx runs fn inside a transaction, committed only if fn returns nil.
func (s *Store) tx(fn func(tx *sql.Tx) error) error {
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

// migrations are applied in order; PRAGMA user_version records how many ran.
// Never edit a released migration: append a new one instead.
var migrations = []string{
	// 1: base schema (identical to the schema of the first release).
	`CREATE TABLE IF NOT EXISTS projects (
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
	CREATE INDEX IF NOT EXISTS idx_tasks_section ON tasks(section_id);

	CREATE TABLE IF NOT EXISTS auth_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS auth_sessions (
		token TEXT PRIMARY KEY,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);`,

	// 2: repair data written by earlier versions so every invariant holds:
	// priorities are 1-3, empty strings are NULL, subtasks live in the project
	// and section of their root task, and sessions are stored hashed.
	`UPDATE tasks SET priority = 3 WHERE priority NOT IN (1, 2, 3);
	UPDATE tasks SET section_id = NULL WHERE section_id = '';
	UPDATE tasks SET parent_id = NULL WHERE parent_id = '';
	UPDATE tasks SET due_date = NULL WHERE due_date = '';
	UPDATE tasks SET recurrence = NULL WHERE recurrence = '';
	UPDATE tasks SET location = NULL WHERE location = '';
	UPDATE tasks SET description = '' WHERE description IS NULL;
	UPDATE projects SET parent_id = NULL WHERE parent_id IN ('', 'inbox');
	UPDATE projects SET parent_id = NULL WHERE id = 'inbox';
	UPDATE projects SET sort_by = 'manual' WHERE sort_by NOT IN ('manual', 'date', 'priority', 'title');
	UPDATE tasks SET section_id = NULL
		WHERE section_id IS NOT NULL
		  AND section_id NOT IN (SELECT s.id FROM sections s WHERE s.project_id = tasks.project_id);
	WITH RECURSIVE tree(id, project_id, section_id) AS (
		SELECT id, project_id, section_id FROM tasks WHERE parent_id IS NULL
		UNION
		SELECT t.id, tree.project_id, tree.section_id FROM tasks t JOIN tree ON t.parent_id = tree.id
	)
	UPDATE tasks
	SET project_id = (SELECT project_id FROM tree WHERE tree.id = tasks.id),
	    section_id = (SELECT section_id FROM tree WHERE tree.id = tasks.id)
	WHERE id IN (SELECT id FROM tree);
	DELETE FROM auth_sessions;
	CREATE INDEX IF NOT EXISTS idx_tasks_siblings ON tasks(project_id, section_id, parent_id, position);`,
}

func (s *Store) migrate() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		err := s.tx(func(tx *sql.Tx) error {
			if _, err := tx.Exec(migrations[i]); err != nil {
				return err
			}
			_, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1))
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
	}
	_, err := s.db.Exec(`INSERT OR IGNORE INTO projects (id, parent_id, name, position, sort_by, sort_order)
		VALUES ('inbox', NULL, 'Inbox', 0, 'manual', 'asc')`)
	return err
}

func newID() string {
	return uuid.NewString()
}

func now() time.Time {
	return time.Now().UTC()
}

// nullable converts an optional string to a SQL value (NULL when nil).
func nullable(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func ptr(ns sql.NullString) *string {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	v := ns.String
	return &v
}

func sameOptional(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
