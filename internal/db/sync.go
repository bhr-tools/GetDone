package db

import (
	"database/sql"
	"time"
)

// syncOpsKept is how long applied changes are remembered.
const syncOpsKept = 30 * 24 * time.Hour

// Snapshot is all the data, flat, for clients that work offline.
type Snapshot struct {
	Projects []*Project `json:"projects"` // inbox included, Children left empty
	Sections []*Section `json:"sections"`
	Tasks    []*Task    `json:"tasks"` // Subtasks left empty
}

// Snapshot reads all projects, sections and tasks in one transaction, so the
// three lists are consistent with each other.
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
		return err
	})
	return snap, err
}

// SyncOpStatus returns the recorded outcome of a change already applied.
func (s *Store) SyncOpStatus(id string) (status, msg string, found bool, err error) {
	err = s.db.QueryRow(`SELECT status, error FROM sync_ops WHERE id = ?`, id).Scan(&status, &msg)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	return status, msg, err == nil, err
}

// RecordSyncOp remembers the outcome of a change.
func (s *Store) RecordSyncOp(id, status, msg string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO sync_ops (id, status, error, applied_at) VALUES (?, ?, ?, ?)`,
		id, status, msg, now())
	return err
}

// PruneSyncOps forgets changes applied long ago.
func (s *Store) PruneSyncOps() error {
	_, err := s.db.Exec(`DELETE FROM sync_ops WHERE applied_at < ?`, now().Add(-syncOpsKept))
	return err
}
