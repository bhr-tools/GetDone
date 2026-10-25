package db

import (
	"database/sql"
	"strings"
	"unicode/utf8"
)

const maxNameLength = 200

func normalizeName(name, what string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", invalid("%s name is required", what)
	}
	if utf8.RuneCountInString(name) > maxNameLength {
		return "", invalid("%s name is too long (%d characters max)", what, maxNameLength)
	}
	return name, nil
}

const projectColumns = `id, parent_id, name, position, sort_by, created_at`

func scanProject(sc interface{ Scan(...any) error }) (*Project, error) {
	p := &Project{Children: []*Project{}}
	var parentID sql.NullString
	if err := sc.Scan(&p.ID, &parentID, &p.Name, &p.Position, &p.SortBy, &p.CreatedAt); err != nil {
		return nil, err
	}
	p.ParentID = ptr(parentID)
	if !ValidSort(p.SortBy) {
		p.SortBy = "manual"
	}
	return p, nil
}

// ListProjects returns the user's projects as a tree, without the inbox.
func (s *Store) ListProjects() ([]*Project, error) {
	rows, err := s.db.Query(`SELECT ` + projectColumns + ` FROM projects
		WHERE id != 'inbox' ORDER BY position, created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var all []*Project
	byID := map[string]*Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		all = append(all, p)
		byID[p.ID] = p
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	roots := []*Project{}
	for _, p := range all {
		if p.ParentID != nil {
			if parent, ok := byID[*p.ParentID]; ok {
				parent.Children = append(parent.Children, p)
				continue
			}
			p.ParentID = nil
		}
		roots = append(roots, p)
	}
	return roots, nil
}

// GetProject returns one project (the inbox included), without its children.
func (s *Store) GetProject(id string) (*Project, error) {
	return getProject(s.db, id)
}

func getProject(q querier, id string) (*Project, error) {
	p, err := scanProject(q.QueryRow(`SELECT `+projectColumns+` FROM projects WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	return p, err
}

// CreateProject adds a project at the end of its parent's children.
func (s *Store) CreateProject(name string, parentID *string) (*Project, error) {
	name, err := normalizeName(name, "Project")
	if err != nil {
		return nil, err
	}
	if parentID != nil && (*parentID == "" || *parentID == InboxID) {
		parentID = nil
	}
	id := newID()
	err = s.tx(func(tx *sql.Tx) error {
		if parentID != nil {
			if _, err := getProject(tx, *parentID); err != nil {
				if err == ErrNotFound {
					return invalid("the parent project does not exist")
				}
				return err
			}
		}
		var maxPos int
		if err := tx.QueryRow(`SELECT COALESCE(MAX(position), 0) FROM projects WHERE parent_id IS ? AND id != 'inbox'`,
			nullable(parentID)).Scan(&maxPos); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO projects (id, parent_id, name, position, sort_by, sort_order, created_at)
			VALUES (?, ?, ?, ?, 'manual', 'asc', ?)`, id, nullable(parentID), name, maxPos+1, now())
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.GetProject(id)
}

// RenameProject changes a project's name.
func (s *Store) RenameProject(id, name string) (*Project, error) {
	if id == InboxID {
		return nil, invalid("the inbox cannot be renamed")
	}
	name, err := normalizeName(name, "Project")
	if err != nil {
		return nil, err
	}
	res, err := s.db.Exec(`UPDATE projects SET name = ? WHERE id = ?`, name, id)
	if err := requireAffected(res, err); err != nil {
		return nil, err
	}
	return s.GetProject(id)
}

// SetProjectSort stores the sort order used to display a project (or the inbox).
func (s *Store) SetProjectSort(id, sortBy string) error {
	if !ValidSort(sortBy) {
		return invalid("unknown sort order %q", sortBy)
	}
	res, err := s.db.Exec(`UPDATE projects SET sort_by = ? WHERE id = ?`, sortBy, id)
	return requireAffected(res, err)
}

// DeleteProject deletes a project with its subprojects, sections and tasks.
func (s *Store) DeleteProject(id string) error {
	if id == InboxID {
		return invalid("the inbox cannot be deleted")
	}
	res, err := s.db.Exec(`DELETE FROM projects WHERE id = ?`, id)
	return requireAffected(res, err)
}

// MoveProject moves a project under parentID (nil for top level), placed
// among its new siblings according to p.
func (s *Store) MoveProject(id string, parentID *string, p Placement) error {
	if id == InboxID {
		return invalid("the inbox cannot be moved")
	}
	if parentID != nil && (*parentID == "" || *parentID == InboxID) {
		parentID = nil
	}
	return s.tx(func(tx *sql.Tx) error {
		if _, err := getProject(tx, id); err != nil {
			return err
		}
		if parentID != nil {
			if _, err := getProject(tx, *parentID); err != nil {
				if err == ErrNotFound {
					return invalid("the parent project does not exist")
				}
				return err
			}
			cycle, err := exists(tx, `WITH RECURSIVE sub(id) AS (
					SELECT ? UNION SELECT p.id FROM projects p JOIN sub ON p.parent_id = sub.id)
				SELECT 1 FROM sub WHERE id = ?`, id, *parentID)
			if err != nil {
				return err
			}
			if cycle {
				return invalid("a project cannot be moved inside itself")
			}
		}
		siblings, err := queryIDs(tx, `SELECT id FROM projects
			WHERE parent_id IS ? AND id != 'inbox' AND id != ? ORDER BY position, created_at`, nullable(parentID), id)
		if err != nil {
			return err
		}
		order, err := place(siblings, id, p)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE projects SET parent_id = ? WHERE id = ?`, nullable(parentID), id); err != nil {
			return err
		}
		return renumber(tx, "projects", order)
	})
}

// requireAffected turns "no row changed" into ErrNotFound.
func requireAffected(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
