package api

import (
	"bytes"
	"database/sql"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/ben/get-done/internal/db"
	"github.com/ben/get-done/internal/parser"
	"github.com/google/uuid"
)

// handleExportCSV exports all tasks and sections of a project as a Todoist-compatible CSV.
func (a *API) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	projectID := strings.TrimSpace(r.URL.Query().Get("project_id"))
	if projectID == "" {
		projectID = "inbox"
	}

	proj, err := a.store.GetProject(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	sections, err := a.store.ListSections(projectID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	tasks, err := a.store.ListProjectTasksForExport(projectID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Organize tasks into hierarchy
	childrenMap := make(map[string][]*db.Task)
	sectionMap := make(map[string][]*db.Task)
	var unsectionedRoots []*db.Task

	for _, t := range tasks {
		if t.ParentID != nil && *t.ParentID != "" {
			childrenMap[*t.ParentID] = append(childrenMap[*t.ParentID], t)
		} else if t.SectionID != nil && *t.SectionID != "" {
			sectionMap[*t.SectionID] = append(sectionMap[*t.SectionID], t)
		} else {
			unsectionedRoots = append(unsectionedRoots, t)
		}
	}

	var buf bytes.Buffer
	wCsv := csv.NewWriter(&buf)

	// Todoist Standard CSV Header
	_ = wCsv.Write([]string{
		"TYPE", "CONTENT", "DESCRIPTION", "PRIORITY", "INDENT", "AUTHOR", "RESPONSIBLE", "DATE", "DATE_LANG", "TIMEZONE",
	})

	var writeTaskTree func(t *db.Task, depth int)
	writeTaskTree = func(t *db.Task, depth int) {
		// Priority mapping: 1 -> 1, 2 -> 2, 3 -> 4 (Todoist p4/normal)
		priStr := "4"
		if t.Priority == 1 {
			priStr = "1"
		} else if t.Priority == 2 {
			priStr = "2"
		} else if t.Priority == 3 {
			priStr = "4"
		}

		// Description & Location
		desc := t.Description
		if t.Location != nil && *t.Location != "" {
			if desc != "" {
				desc = desc + "\nLocation: " + *t.Location
			} else {
				desc = "Location: " + *t.Location
			}
		}

		// Date & Recurrence
		dateStr := ""
		if t.Recurrence != nil && *t.Recurrence != "" {
			dateStr = formatRecurrenceForTodoist(*t.Recurrence, t.DueDate)
		} else if t.DueDate != nil && *t.DueDate != "" {
			dateStr = *t.DueDate
		}

		_ = wCsv.Write([]string{
			"task",
			t.Title,
			desc,
			priStr,
			strconv.Itoa(depth),
			"",
			"",
			dateStr,
			"en",
			"",
		})

		for _, child := range childrenMap[t.ID] {
			writeTaskTree(child, depth+1)
		}
	}

	// 1. Root unsectioned tasks first
	for _, root := range unsectionedRoots {
		writeTaskTree(root, 1)
	}

	// 2. Sections and their tasks
	for _, sec := range sections {
		_ = wCsv.Write([]string{
			"section",
			sec.Name,
			"",
			"1",
			"1",
			"",
			"",
			"",
			"en",
			"",
		})
		for _, st := range sectionMap[sec.ID] {
			writeTaskTree(st, 1)
		}
	}

	wCsv.Flush()
	if err := wCsv.Error(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate CSV: "+err.Error())
		return
	}

	// Sanitize filename
	safeName := strings.TrimSpace(proj.Name)
	if safeName == "" {
		safeName = "project"
	}
	safeName = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == ' ' {
			return r
		}
		return '_'
	}, safeName)
	filename := fmt.Sprintf("%s.csv", safeName)

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// formatRecurrenceForTodoist converts internal recurrence strings to Todoist natural syntax.
func formatRecurrenceForTodoist(rec string, dueDate *string) string {
	var text string
	switch {
	case rec == "daily":
		text = "every day"
	case rec == "weekly":
		text = "every week"
	case rec == "monthly":
		text = "every month"
	case rec == "yearly":
		text = "every year"
	case rec == "weekdays":
		text = "every weekday"
	case strings.HasPrefix(rec, "weekly:"):
		day := strings.TrimPrefix(rec, "weekly:")
		text = "every " + day
	default:
		text = rec
	}

	if dueDate != nil && *dueDate != "" {
		if strings.Contains(*dueDate, " ") {
			parts := strings.SplitN(*dueDate, " ", 2)
			text += " at " + parts[1]
		}
	}
	return text
}

// handleImportCSV imports a Todoist-compatible CSV into the specified project.
func (a *API) handleImportCSV(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	projectID := strings.TrimSpace(r.URL.Query().Get("project_id"))
	if projectID == "" {
		projectID = "inbox"
	}

	_, err := a.store.GetProject(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	var csvData []byte
	contentType := r.Header.Get("Content-Type")

	if strings.HasPrefix(contentType, "multipart/form-data") {
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			writeError(w, http.StatusBadRequest, "failed to parse multipart form: "+err.Error())
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "missing 'file' in upload: "+err.Error())
			return
		}
		defer file.Close()
		csvData, err = io.ReadAll(file)
		if err != nil {
			writeError(w, http.StatusBadRequest, "failed to read uploaded file: "+err.Error())
			return
		}
	} else {
		var err error
		csvData, err = io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "failed to read request body: "+err.Error())
			return
		}
	}

	if len(csvData) == 0 {
		writeError(w, http.StatusBadRequest, "empty CSV content")
		return
	}

	// Strip UTF-8 BOM if present
	csvData = bytes.TrimPrefix(csvData, []byte("\xef\xbb\xbf"))

	// Detect delimiter
	sampleSize := len(csvData)
	if sampleSize > 2048 {
		sampleSize = 2048
	}
	sample := csvData[:sampleSize]

	commaCount := bytes.Count(sample, []byte{','})
	semicolonCount := bytes.Count(sample, []byte{';'})
	tabCount := bytes.Count(sample, []byte{'\t'})

	delimiter := ','
	if semicolonCount > commaCount && semicolonCount > tabCount {
		delimiter = ';'
	} else if tabCount > commaCount && tabCount > semicolonCount {
		delimiter = '\t'
	}

	reader := csv.NewReader(bytes.NewReader(csvData))
	reader.Comma = delimiter
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1

	records, err := reader.ReadAll()
	if err != nil {
		writeError(w, http.StatusBadRequest, "CSV parse error: "+err.Error())
		return
	}

	if len(records) < 2 {
		writeError(w, http.StatusBadRequest, "CSV must contain at least a header and one row")
		return
	}

	// Map header columns
	colType := -1
	colContent := -1
	colDesc := -1
	colPriority := -1
	colIndent := -1
	colDate := -1
	colLocation := -1

	for idx, col := range records[0] {
		norm := strings.TrimSpace(strings.ToUpper(col))
		switch norm {
		case "TYPE":
			colType = idx
		case "CONTENT", "TITLE", "TASK", "NAME":
			colContent = idx
		case "DESCRIPTION", "DESC", "NOTES", "NOTE":
			colDesc = idx
		case "PRIORITY":
			colPriority = idx
		case "INDENT":
			colIndent = idx
		case "DATE", "DUE DATE", "DUE_DATE":
			colDate = idx
		case "LOCATION", "LIEU", "ADRESSE":
			colLocation = idx
		}
	}

	if colContent == -1 {
		writeError(w, http.StatusBadRequest, "missing required CONTENT/TITLE column in CSV")
		return
	}

	tasksCount := 0
	sectionsCount := 0

	err = a.store.RunInTx(func(tx *sql.Tx) error {
		var maxSecPos int
		_ = tx.QueryRow("SELECT COALESCE(MAX(position), 0) FROM sections WHERE project_id = ?", projectID).Scan(&maxSecPos)

		var maxTaskPos int
		_ = tx.QueryRow("SELECT COALESCE(MAX(position), 0) FROM tasks WHERE project_id = ?", projectID).Scan(&maxTaskPos)

		var currentSectionID *string
		indentMap := make(map[int]string)
		var lastCreatedTaskID string

		getVal := func(row []string, idx int) string {
			if idx >= 0 && idx < len(row) {
				return strings.TrimSpace(row[idx])
			}
			return ""
		}

		for i := 1; i < len(records); i++ {
			row := records[i]
			rowType := "task"
			if colType >= 0 {
				t := strings.ToLower(getVal(row, colType))
				if t != "" {
					rowType = t
				}
			}

			content := getVal(row, colContent)
			if content == "" {
				continue
			}

			if rowType == "section" {
				var secID string
				err := tx.QueryRow("SELECT id FROM sections WHERE project_id = ? AND LOWER(name) = LOWER(?)", projectID, content).Scan(&secID)
				if err != nil {
					secID = uuid.New().String()
					maxSecPos++
					_, err := tx.Exec("INSERT INTO sections (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)",
						secID, projectID, content, maxSecPos, time.Now())
					if err != nil {
						return err
					}
					sectionsCount++
				}
				currentSectionID = &secID
				indentMap = make(map[int]string)
				lastCreatedTaskID = ""
				continue
			}

			if rowType == "note" {
				if lastCreatedTaskID != "" {
					_, _ = tx.Exec(`UPDATE tasks SET description = CASE WHEN description = '' THEN ? ELSE description || char(10) || ? END WHERE id = ?`, content, content, lastCreatedTaskID)
				}
				continue
			}

			// Task row
			desc := getVal(row, colDesc)

			var location *string
			if colLocation >= 0 {
				loc := getVal(row, colLocation)
				if loc != "" {
					location = &loc
				}
			}
			if location == nil && desc != "" {
				lines := strings.Split(desc, "\n")
				var cleanLines []string
				for _, l := range lines {
					trimmed := strings.TrimSpace(l)
					if strings.HasPrefix(strings.ToLower(trimmed), "location:") {
						loc := strings.TrimSpace(trimmed[9:])
						if loc != "" {
							location = &loc
						}
					} else {
						cleanLines = append(cleanLines, l)
					}
				}
				desc = strings.TrimSpace(strings.Join(cleanLines, "\n"))
			}

			priVal := 3
			if colPriority >= 0 {
				switch getVal(row, colPriority) {
				case "1":
					priVal = 1
				case "2":
					priVal = 2
				case "3":
					priVal = 3
				case "4":
					priVal = 3
				}
			}

			indent := 1
			if colIndent >= 0 {
				if v, err := strconv.Atoi(getVal(row, colIndent)); err == nil && v >= 1 {
					indent = v
				}
			}

			var parentID *string
			if indent > 1 {
				if pid, ok := indentMap[indent-1]; ok && pid != "" {
					parentID = &pid
				} else {
					bestK := 0
					for k := range indentMap {
						if k < indent && k > bestK {
							bestK = k
						}
					}
					if bestK > 0 {
						pid := indentMap[bestK]
						parentID = &pid
					}
				}
			}

			secID := currentSectionID

			var dueDate *string
			var recurrence *string
			if colDate >= 0 {
				dateStr := getVal(row, colDate)
				if dateStr != "" {
					rec, cleaned := parser.ExtractRecurrence(dateStr)
					if rec != "" {
						recurrence = &rec
					}
					due, _ := parser.ExtractDueDate(cleaned, time.Now())
					if due != "" {
						dueDate = &due
					} else if strings.Contains(dateStr, "-") {
						dueDate = &dateStr
					}
				}
			}

			taskID := uuid.New().String()
			maxTaskPos++
			now := time.Now()

			_, err := tx.Exec(`
				INSERT INTO tasks (id, project_id, section_id, parent_id, title, description, priority, due_date, recurrence, location, position, is_collapsed, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
			`, taskID, projectID, secID, parentID, content, desc, priVal, dueDate, recurrence, location, maxTaskPos, now, now)
			if err != nil {
				return err
			}

			indentMap[indent] = taskID
			for k := range indentMap {
				if k > indent {
					delete(indentMap, k)
				}
			}
			lastCreatedTaskID = taskID
			tasksCount++
		}
		return nil
	})

	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to import CSV: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":        true,
		"tasks_count":    tasksCount,
		"sections_count": sectionsCount,
	})
}
