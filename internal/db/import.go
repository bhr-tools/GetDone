package db

import (
	"database/sql"
	"strings"
)

// ImportRow is one decoded line of a Todoist CSV file.
type ImportRow struct {
	Type        string // task | section | note
	Content     string
	Description string
	Priority    int // 1-3
	Indent      int // 1 for a top-level task
	DueDate     *string
	Recurrence  *string
	Location    *string
}

// ImportResult counts what an import created.
type ImportResult struct {
	Tasks    int `json:"tasks_count"`
	Sections int `json:"sections_count"`
}

// ImportRows appends the rows to a project in one transaction. Section rows
// reuse an existing section of the same name (the inbox has no sections, so
// they are ignored there); note rows are appended to the previous task's
// description; indentation builds subtasks.
func (s *Store) ImportRows(projectID string, rows []ImportRow) (*ImportResult, error) {
	result := &ImportResult{}
	err := s.tx(func(tx *sql.Tx) error {
		if err := requireSectionProject(tx, projectID, nil); err != nil {
			return err
		}
		var section *string
		parents := map[int]string{} // indent level -> id of the last task at that level
		lastTask := ""

		for _, row := range rows {
			content := strings.TrimSpace(row.Content)
			if content == "" {
				continue
			}
			switch row.Type {
			case "section":
				parents, lastTask = map[int]string{}, ""
				if projectID == InboxID {
					section = nil
					continue
				}
				id, created, err := findOrCreateSection(tx, projectID, content)
				if err != nil {
					return err
				}
				if created {
					result.Sections++
				}
				section = &id
			case "note":
				if lastTask != "" {
					if _, err := tx.Exec(`UPDATE tasks SET description = CASE WHEN description = '' THEN ? ELSE description || char(10) || ? END
						WHERE id = ?`, content, content, lastTask); err != nil {
						return err
					}
				}
			default:
				id, err := importTask(tx, projectID, section, parentFor(parents, row.Indent), row, content)
				if err != nil {
					return err
				}
				indent := max(row.Indent, 1)
				parents[indent] = id
				for level := range parents {
					if level > indent {
						delete(parents, level)
					}
				}
				lastTask = id
				result.Tasks++
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// parentFor returns the task a row at indent should be nested under: the last
// task seen at the deepest shallower level.
func parentFor(parents map[int]string, indent int) *string {
	for level := indent - 1; level >= 1; level-- {
		if id, ok := parents[level]; ok {
			return &id
		}
	}
	return nil
}

func findOrCreateSection(tx *sql.Tx, projectID, name string) (id string, created bool, err error) {
	name, err = normalizeName(truncate(name, maxNameLength), "Section")
	if err != nil {
		return "", false, err
	}
	err = tx.QueryRow(`SELECT id FROM sections WHERE project_id = ? AND lower(name) = lower(?) ORDER BY position LIMIT 1`,
		projectID, name).Scan(&id)
	if err == nil {
		return id, false, nil
	}
	if err != sql.ErrNoRows {
		return "", false, err
	}
	var maxPos int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(position), 0) FROM sections WHERE project_id = ?`, projectID).Scan(&maxPos); err != nil {
		return "", false, err
	}
	id = newID()
	_, err = tx.Exec(`INSERT INTO sections (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, projectID, name, maxPos+1, now())
	return id, err == nil, err
}

func importTask(tx *sql.Tx, projectID string, section, parent *string, row ImportRow, content string) (string, error) {
	sl := slot{projectID: projectID, sectionID: section, parentID: parent}
	maxPos, err := sl.maxPosition(tx)
	if err != nil {
		return "", err
	}
	title, err := normalizeTitle(truncate(content, maxTitleLength))
	if err != nil {
		return "", err
	}
	description, _ := normalizeDescription(truncate(row.Description, maxDescriptionLength))
	priority, err := normalizePriority(row.Priority)
	if err != nil {
		priority = defaultPriority
	}
	due, _ := normalizeDue(row.DueDate)
	recurrence, _ := normalizeRecurrence(row.Recurrence)
	location, _ := normalizeLocation(row.Location)
	id, ts := newID(), now()
	_, err = tx.Exec(`INSERT INTO tasks (id, project_id, section_id, parent_id, title, description,
			priority, due_date, recurrence, location, position, is_collapsed, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		id, projectID, nullable(section), nullable(parent), title, description,
		priority, nullable(due), nullable(recurrence), nullable(location), maxPos+1, ts, ts)
	return id, err
}

func truncate(s string, maxRunes int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > maxRunes {
		return string(r[:maxRunes])
	}
	return string(r)
}
