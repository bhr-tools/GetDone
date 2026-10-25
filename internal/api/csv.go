package api

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"

	"github.com/ben/get-done/internal/db"
	"github.com/ben/get-done/internal/parser"
)

// Todoist's CSV template columns.
var csvHeader = []string{"TYPE", "CONTENT", "DESCRIPTION", "PRIORITY", "INDENT", "AUTHOR", "RESPONSIBLE", "DATE", "DATE_LANG", "TIMEZONE"}

// Locations have no Todoist column; they travel in the description.
const locationPrefix = "Location: "

// In Todoist CSV files, PRIORITY 1 is the highest and 4 the lowest ("normal").
var todoistPriority = map[int]string{1: "1", 2: "2", 3: "4"}

func (a *API) exportCSV(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	project, err := a.store.GetProject(projectID)
	if err != nil {
		fail(w, r, err)
		return
	}
	sections, err := a.store.ListSections(projectID)
	if err != nil {
		fail(w, r, err)
		return
	}
	view := "project"
	if projectID == db.InboxID {
		view = "inbox"
	}
	roots, err := a.store.ListTasks(db.TaskFilter{View: view, ProjectID: projectID, Sort: "manual"})
	if err != nil {
		fail(w, r, err)
		return
	}

	var buf bytes.Buffer
	out := csv.NewWriter(&buf)
	_ = out.Write(csvHeader)
	var writeTree func(t *db.Task, indent int)
	writeTree = func(t *db.Task, indent int) {
		_ = out.Write([]string{"task", t.Title, exportDescription(t), todoistPriority[t.Priority],
			strconv.Itoa(indent), "", "", exportDate(t), "en", ""})
		for _, sub := range t.Subtasks {
			writeTree(sub, indent+1)
		}
	}
	for _, t := range roots {
		if t.SectionID == nil {
			writeTree(t, 1)
		}
	}
	for _, sec := range sections {
		_ = out.Write([]string{"section", sec.Name, "", "", "", "", "", "", "", ""})
		for _, t := range roots {
			if t.SectionID != nil && *t.SectionID == sec.ID {
				writeTree(t, 1)
			}
		}
	}
	out.Flush()
	if err := out.Error(); err != nil {
		fail(w, r, err)
		return
	}

	name := exportFileName(project.Name)
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`,
		asciiFileName(name), url.PathEscape(name)))
	_, _ = w.Write(buf.Bytes())
}

func exportDescription(t *db.Task) string {
	if t.Location == nil {
		return t.Description
	}
	if t.Description == "" {
		return locationPrefix + *t.Location
	}
	return t.Description + "\n" + locationPrefix + *t.Location
}

// exportDate writes the due date and recurrence in Todoist's natural syntax,
// which the importer below reads back.
func exportDate(t *db.Task) string {
	if t.Recurrence == nil {
		if t.DueDate == nil {
			return ""
		}
		return *t.DueDate
	}
	rule := *t.Recurrence
	text := map[string]string{
		"daily": "every day", "weekdays": "every weekday", "weekly": "every week",
		"monthly": "every month", "yearly": "every year",
	}[rule]
	switch {
	case text != "":
	case strings.HasPrefix(rule, "weekly:"):
		text = "every " + strings.TrimPrefix(rule, "weekly:")
	default:
		text = rule // cron rules have no Todoist equivalent
	}
	if t.DueDate != nil {
		day, clock, _ := strings.Cut(*t.DueDate, " ")
		text += " starting " + day
		if clock != "" {
			text += " at " + clock
		}
	}
	return text
}

func exportFileName(projectName string) string {
	name := strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == ' ' {
			return r
		}
		return '_'
	}, strings.TrimSpace(projectName))
	if strings.Trim(name, "_ ") == "" {
		name = "project"
	}
	return name + ".csv"
}

func asciiFileName(name string) string {
	return strings.Map(func(r rune) rune {
		if r > unicode.MaxASCII {
			return '_'
		}
		return r
	}, name)
}

func (a *API) importCSV(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	data, err := readUpload(w, r)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "The file is larger than 10 MB")
		} else {
			writeError(w, http.StatusBadRequest, "Could not read the uploaded file: "+err.Error())
		}
		return
	}
	rows, err := decodeCSV(data, parser.NormalizeToday(r.URL.Query().Get("today")))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := a.store.ImportRows(projectID, rows)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// readUpload returns the CSV bytes, sent either as a multipart "file" field
// or as the raw request body.
func readUpload(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBody)
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		if err := r.ParseMultipartForm(maxUploadBody); err != nil {
			return nil, err
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			return nil, err
		}
		defer file.Close()
		return io.ReadAll(file)
	}
	return io.ReadAll(r.Body)
}

// decodeCSV parses a Todoist CSV (comma, semicolon or tab separated, with or
// without a UTF-8 BOM) into import rows.
func decodeCSV(data []byte, today string) ([]db.ImportRow, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, errors.New("The file is empty")
	}
	reader := csv.NewReader(bytes.NewReader(data))
	reader.Comma = detectDelimiter(data)
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("The file is not a valid CSV: %v", err)
	}
	if len(records) < 2 {
		return nil, errors.New("The file must contain a header and at least one row")
	}

	cols := map[string]int{}
	aliases := map[string]string{
		"TYPE": "type", "CONTENT": "content", "TITLE": "content", "TASK": "content", "NAME": "content",
		"DESCRIPTION": "description", "DESC": "description", "NOTES": "description", "NOTE": "description",
		"PRIORITY": "priority", "INDENT": "indent", "DATE": "date", "DUE DATE": "date", "DUE_DATE": "date",
		"LOCATION": "location", "LIEU": "location", "ADRESSE": "location",
	}
	for i, name := range records[0] {
		if key, ok := aliases[strings.ToUpper(strings.TrimSpace(name))]; ok {
			if _, seen := cols[key]; !seen {
				cols[key] = i
			}
		}
	}
	if _, ok := cols["content"]; !ok {
		return nil, errors.New("The file has no CONTENT (or TITLE) column")
	}
	field := func(rec []string, key string) string {
		if i, ok := cols[key]; ok && i < len(rec) {
			return strings.TrimSpace(rec[i])
		}
		return ""
	}

	rows := make([]db.ImportRow, 0, len(records)-1)
	for _, rec := range records[1:] {
		row := db.ImportRow{
			Type:    strings.ToLower(field(rec, "type")),
			Content: field(rec, "content"),
			Indent:  1,
		}
		if row.Type == "" {
			row.Type = "task"
		}
		if n, err := strconv.Atoi(field(rec, "indent")); err == nil && n > 1 {
			row.Indent = n
		}
		row.Priority = map[string]int{"1": 1, "2": 2}[field(rec, "priority")] // anything else: normal
		row.Description, row.Location = splitLocation(field(rec, "description"))
		if loc := field(rec, "location"); loc != "" {
			row.Location = &loc
		}
		row.DueDate, row.Recurrence = importDate(field(rec, "date"), today)
		rows = append(rows, row)
	}
	return rows, nil
}

// splitLocation extracts a "Location: ..." line from a description.
func splitLocation(desc string) (string, *string) {
	var kept []string
	var location *string
	for _, line := range strings.Split(desc, "\n") {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) > len(locationPrefix) && strings.EqualFold(trimmed[:len(locationPrefix)], locationPrefix) {
			loc := strings.TrimSpace(trimmed[len(locationPrefix):])
			location = &loc
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n")), location
}

// importDate reads a Todoist DATE cell such as "2026-11-01", "tomorrow 9am"
// or "every monday starting 2026-11-02 at 09:00".
func importDate(cell, today string) (due, recurrence *string) {
	if cell == "" {
		return nil, nil
	}
	rule, rest := parser.ExtractRecurrence(cell)
	if rule != "" {
		recurrence = &rule
	}
	if d, _ := parser.ExtractDueDate(rest, today); d != "" {
		due = &d
	}
	// "every monday" alone: start on the next Monday.
	if due == nil && strings.HasPrefix(rule, "weekly:") {
		d := parser.NextDueDate("", rule, today)
		due = &d
	}
	return due, recurrence
}

func detectDelimiter(data []byte) rune {
	sample := data[:min(len(data), 2048)]
	if end := bytes.IndexByte(sample, '\n'); end > 0 {
		sample = sample[:end] // the header line is the most reliable
	}
	best, bestCount := ',', bytes.Count(sample, []byte{','})
	for _, d := range []rune{';', '\t'} {
		if n := bytes.Count(sample, []byte(string(d))); n > bestCount {
			best, bestCount = d, n
		}
	}
	return best
}
