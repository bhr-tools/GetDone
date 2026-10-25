package db

import "database/sql"

const sectionColumns = `id, project_id, name, position, created_at`

func scanSection(sc interface{ Scan(...any) error }) (*Section, error) {
	sec := &Section{}
	err := sc.Scan(&sec.ID, &sec.ProjectID, &sec.Name, &sec.Position, &sec.CreatedAt)
	return sec, err
}

// ListSections returns the sections of a project in display order.
func (s *Store) ListSections(projectID string) ([]*Section, error) {
	rows, err := s.db.Query(`SELECT `+sectionColumns+` FROM sections
		WHERE project_id = ? ORDER BY position, created_at`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sections := []*Section{}
	for rows.Next() {
		sec, err := scanSection(rows)
		if err != nil {
			return nil, err
		}
		sections = append(sections, sec)
	}
	return sections, rows.Err()
}

// GetSection returns one section.
func (s *Store) GetSection(id string) (*Section, error) {
	return getSection(s.db, id)
}

func getSection(q querier, id string) (*Section, error) {
	sec, err := scanSection(q.QueryRow(`SELECT `+sectionColumns+` FROM sections WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	return sec, err
}

// requireSectionProject returns an error unless project projectID exists and,
// when sectionID is set, the section belongs to that project.
func requireSectionProject(q querier, projectID string, sectionID *string) error {
	if _, err := getProject(q, projectID); err != nil {
		if err == ErrNotFound {
			return invalid("the project does not exist")
		}
		return err
	}
	if sectionID == nil {
		return nil
	}
	sec, err := getSection(q, *sectionID)
	if err == ErrNotFound || (err == nil && sec.ProjectID != projectID) {
		return invalid("the section does not belong to this project")
	}
	return err
}

// CreateSection adds a section at the end of a project.
func (s *Store) CreateSection(projectID, name string) (*Section, error) {
	name, err := normalizeName(name, "Section")
	if err != nil {
		return nil, err
	}
	if projectID == InboxID {
		return nil, invalid("the inbox has no sections")
	}
	id := newID()
	err = s.tx(func(tx *sql.Tx) error {
		if err := requireSectionProject(tx, projectID, nil); err != nil {
			return err
		}
		var maxPos int
		if err := tx.QueryRow(`SELECT COALESCE(MAX(position), 0) FROM sections WHERE project_id = ?`, projectID).Scan(&maxPos); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO sections (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)`,
			id, projectID, name, maxPos+1, now())
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.GetSection(id)
}

// RenameSection changes a section's name.
func (s *Store) RenameSection(id, name string) (*Section, error) {
	name, err := normalizeName(name, "Section")
	if err != nil {
		return nil, err
	}
	res, err := s.db.Exec(`UPDATE sections SET name = ? WHERE id = ?`, name, id)
	if err := requireAffected(res, err); err != nil {
		return nil, err
	}
	return s.GetSection(id)
}

// DeleteSection deletes a section and all its tasks.
func (s *Store) DeleteSection(id string) error {
	res, err := s.db.Exec(`DELETE FROM sections WHERE id = ?`, id)
	return requireAffected(res, err)
}

// MoveSection moves a section, with all its tasks, into projectID (empty for
// its current project), placed among that project's sections according to p.
func (s *Store) MoveSection(id, projectID string, p Placement) error {
	return s.tx(func(tx *sql.Tx) error {
		sec, err := getSection(tx, id)
		if err != nil {
			return err
		}
		if projectID == "" {
			projectID = sec.ProjectID
		}
		if projectID == InboxID {
			return invalid("the inbox has no sections")
		}
		if err := requireSectionProject(tx, projectID, nil); err != nil {
			return err
		}
		siblings, err := queryIDs(tx, `SELECT id FROM sections WHERE project_id = ? AND id != ? ORDER BY position, created_at`, projectID, id)
		if err != nil {
			return err
		}
		order, err := place(siblings, id, p)
		if err != nil {
			return err
		}
		if projectID != sec.ProjectID {
			if _, err := tx.Exec(`UPDATE sections SET project_id = ? WHERE id = ?`, projectID, id); err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE tasks SET project_id = ?, updated_at = ? WHERE section_id = ?`, projectID, now(), id); err != nil {
				return err
			}
		}
		return renumber(tx, "sections", order)
	})
}
