package db

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// An app token lets another app (the Assistant…) add tasks to one project
// the user chose, and read that project's tasks; nothing else. The user
// grants it from the connect page; it never expires and survives a password
// change, until the user disconnects the app or deletes the project. Stored
// hashed, like sessions.

// App is a connected app, as listed to the user.
type App struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	ProjectID   string  `json:"project_id"`
	ProjectName string  `json:"project_name"`
	CreatedAt   string  `json:"created_at"`
	UsedAt      *string `json:"used_at"`
}

// CreateAppToken connects an app to a project and returns its token.
func (s *Store) CreateAppToken(name, projectID string) (string, error) {
	if _, err := s.GetProject(projectID); err != nil {
		return "", err
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	_, err := s.db.Exec(`INSERT INTO app_tokens (name, project_id, token_hash, created_at) VALUES (?, ?, ?, ?)`,
		name, projectID, tokenHash(token), now().Format(time.DateTime))
	if err != nil {
		return "", err
	}
	return token, nil
}

// AppProject returns the project an app token may use, and records the use.
func (s *Store) AppProject(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	var project string
	if err := s.db.QueryRow(`SELECT project_id FROM app_tokens WHERE token_hash = ?`, tokenHash(token)).Scan(&project); err != nil {
		return "", false
	}
	_, _ = s.db.Exec(`UPDATE app_tokens SET used_at = ? WHERE token_hash = ?`, now().Format(time.DateTime), tokenHash(token))
	return project, true
}

// ListApps returns the connected apps, oldest first.
func (s *Store) ListApps() ([]App, error) {
	rows, err := s.db.Query(`SELECT a.id, a.name, a.project_id, COALESCE(p.name, ''), a.created_at, a.used_at
		FROM app_tokens a LEFT JOIN projects p ON p.id = a.project_id ORDER BY a.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	apps := []App{}
	for rows.Next() {
		var a App
		var used *string
		if err := rows.Scan(&a.ID, &a.Name, &a.ProjectID, &a.ProjectName, &a.CreatedAt, &used); err != nil {
			return nil, err
		}
		a.UsedAt = used
		apps = append(apps, a)
	}
	return apps, rows.Err()
}

// DeleteApp disconnects an app by id.
func (s *Store) DeleteApp(id int64) error {
	_, err := s.db.Exec(`DELETE FROM app_tokens WHERE id = ?`, id)
	return err
}

// DeleteAppToken disconnects the app holding the token (the app leaving).
func (s *Store) DeleteAppToken(token string) error {
	_, err := s.db.Exec(`DELETE FROM app_tokens WHERE token_hash = ?`, tokenHash(token))
	return err
}
