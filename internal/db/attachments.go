package db

import (
	"database/sql"
	"errors"
	"io"
	"os"
	"time"

	"github.com/bhr-tools/kit/files"
)

// MaxAttachmentSize is the largest accepted file.
const MaxAttachmentSize = 25 << 20

// AttachmentRetention is how long deleted attachments, and the attachments of
// completed or deleted tasks, are kept for undo.
const AttachmentRetention = 30 * 24 * time.Hour

// Attachment is a file attached to a task: a ticket, a photo, a document. The
// file lives in the attachments directory under its id; the name it was
// uploaded with is only shown.
type Attachment struct {
	ID          string `json:"id"`
	TaskID      string `json:"task_id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	CreatedAt   string `json:"created_at"`
	URL         string `json:"url,omitempty"` // set by the API: a signed link that works without the session cookie
}

const attachmentColumns = `id, task_id, filename, content_type, size, created_at`

func scanAttachment(r interface{ Scan(...any) error }) (Attachment, error) {
	var a Attachment
	err := r.Scan(&a.ID, &a.TaskID, &a.Filename, &a.ContentType, &a.Size, &a.CreatedAt)
	return a, err
}

func stamp() string {
	return now().Format(time.RFC3339)
}

// AddAttachment stores a file for a task (kit files: streamed, synced,
// renamed, so a failed upload leaves nothing behind; empty files and files
// above MaxAttachmentSize are refused).
func (s *Store) AddAttachment(taskID, filename, contentType string, content io.Reader) (Attachment, error) {
	if ok, err := exists(s.db, `SELECT 1 FROM tasks WHERE id = ?`, taskID); err != nil {
		return Attachment{}, err
	} else if !ok {
		return Attachment{}, ErrNotFound
	}
	a := Attachment{
		ID:          newID(),
		TaskID:      taskID,
		Filename:    files.CleanFilename(filename),
		ContentType: contentType,
		CreatedAt:   stamp(),
	}
	size, err := s.files.Save(a.ID, content)
	if err != nil {
		return Attachment{}, err
	}
	a.Size = size
	_, err = s.db.Exec(`INSERT INTO attachments (`+attachmentColumns+`) VALUES (?, ?, ?, ?, ?, ?)`,
		a.ID, a.TaskID, a.Filename, a.ContentType, a.Size, a.CreatedAt)
	if err != nil {
		s.files.Remove(a.ID)
		return Attachment{}, err
	}
	return a, nil
}

// GetAttachment returns a live attachment.
func (s *Store) GetAttachment(id string) (Attachment, error) {
	a, err := scanAttachment(s.db.QueryRow(`SELECT `+attachmentColumns+` FROM attachments WHERE id = ? AND deleted_at = ''`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Attachment{}, ErrNotFound
	}
	return a, err
}

// OpenAttachment opens the file of a live attachment.
func (s *Store) OpenAttachment(id string) (Attachment, *os.File, error) {
	a, err := s.GetAttachment(id)
	if err != nil {
		return Attachment{}, nil, err
	}
	f, err := s.files.Open(a.ID)
	return a, f, err
}

// listAttachments returns the live attachments of existing tasks, oldest
// first within a task.
func listAttachments(q querier) ([]Attachment, error) {
	rows, err := q.Query(`SELECT ` + attachmentColumns + ` FROM attachments
		WHERE deleted_at = '' AND task_id IN (SELECT id FROM tasks)
		ORDER BY task_id, created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Attachment{}
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DeleteAttachment moves an attachment to the trash; RestoreAttachment takes
// it back until the purge removes the file.
func (s *Store) DeleteAttachment(id string) error {
	res, err := s.db.Exec(`UPDATE attachments SET deleted_at = ? WHERE id = ? AND deleted_at = ''`, stamp(), id)
	return requireAffected(res, err)
}

func (s *Store) RestoreAttachment(id string) error {
	res, err := s.db.Exec(`UPDATE attachments SET deleted_at = '' WHERE id = ?`, id)
	return requireAffected(res, err)
}

// PurgeAttachments removes the files deleted before cutoff, and those whose
// task has been gone (completed or deleted) since before cutoff, plus any
// upload interrupted by a crash. It returns how many attachments were removed.
//
// Tasks are deleted by plain SQL (with their subtasks, projects and
// sections), so the purge notices orphans itself: it stamps them on its
// first pass and clears the stamp when undo has brought the task back.
func (s *Store) PurgeAttachments(cutoff time.Time) (int, error) {
	if _, err := s.db.Exec(`UPDATE attachments SET orphaned_at = ?
		WHERE orphaned_at = '' AND task_id NOT IN (SELECT id FROM tasks)`, stamp()); err != nil {
		return 0, err
	}
	if _, err := s.db.Exec(`UPDATE attachments SET orphaned_at = ''
		WHERE orphaned_at != '' AND task_id IN (SELECT id FROM tasks)`); err != nil {
		return 0, err
	}
	c := cutoff.UTC().Format(time.RFC3339)
	ids, err := queryIDs(s.db, `SELECT id FROM attachments
		WHERE (deleted_at != '' AND deleted_at < ?) OR (orphaned_at != '' AND orphaned_at < ?)`, c, c)
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		if err := s.files.Remove(id); err != nil {
			return 0, err
		}
		if _, err := s.db.Exec(`DELETE FROM attachments WHERE id = ?`, id); err != nil {
			return 0, err
		}
	}
	s.files.CleanLeftovers()
	return len(ids), nil
}
