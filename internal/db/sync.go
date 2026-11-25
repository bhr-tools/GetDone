package db

import "database/sql"

// Snapshot is all the data, flat, for clients that work offline.
type Snapshot struct {
	Projects []*Project `json:"projects"` // inbox included, Children left empty
	Sections []*Section `json:"sections"`
	Tasks    []*Task    `json:"tasks"` // Subtasks left empty
	// Files of the tasks above. Their URL is left for the API to sign.
	Attachments []Attachment `json:"attachments"`
}

// Snapshot reads all projects, sections, tasks and attachments in one
// transaction, so the lists are consistent with each other.
func (s *Store) Snapshot() (*Snapshot, error) {
	snap := &Snapshot{Projects: []*Project{}, Sections: []*Section{}}
	err := s.tx(func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT ` + projectColumns + ` FROM projects ORDER BY position, created_at`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			p, err := scanProject(rows)
			if err != nil {
				return err
			}
			snap.Projects = append(snap.Projects, p)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		srows, err := tx.Query(`SELECT ` + sectionColumns + ` FROM sections ORDER BY project_id, position, created_at`)
		if err != nil {
			return err
		}
		defer srows.Close()
		for srows.Next() {
			sec, err := scanSection(srows)
			if err != nil {
				return err
			}
			snap.Sections = append(snap.Sections, sec)
		}
		if err := srows.Err(); err != nil {
			return err
		}

		snap.Tasks, err = queryTasks(tx, `SELECT `+taskColumns+taskFrom+`ORDER BY t.position, t.created_at`)
		if err != nil {
			return err
		}
		snap.Attachments, err = listAttachments(tx)
		return err
	})
	return snap, err
}
