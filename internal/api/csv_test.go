package api

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ben/get-done/internal/db"
)

func setupTestAPI(t *testing.T) (*API, *db.Store) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")
	store, err := db.NewStore(dbPath)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	api := NewAPI(store, true) // noAuth = true
	return api, store
}

func TestCSVExportAndImport(t *testing.T) {
	api, store := setupTestAPI(t)
	defer store.Close()

	// 1. Create a project
	proj := &db.Project{Name: "Vacances"}
	if err := store.CreateProject(proj); err != nil {
		t.Fatalf("failed to create project: %v", err)
	}

	// 2. Create sections
	sec1 := &db.Section{ProjectID: proj.ID, Name: "Preparations", Position: 1}
	if err := store.CreateSection(sec1); err != nil {
		t.Fatalf("failed to create section: %v", err)
	}

	// 3. Create tasks:
	// - Root task without section
	locParis := "Central Station, London"
	recDaily := "daily"
	dueDate := "2026-11-01"
	tRoot := &db.Task{
		ProjectID: proj.ID,
		Title:     "Buy train tickets",
		Priority:  1,
		DueDate:   &dueDate,
		Location:  &locParis,
	}
	if err := store.CreateTask(tRoot); err != nil {
		t.Fatalf("failed to create root task: %v", err)
	}

	// - Subtask of tRoot
	tSub := &db.Task{
		ProjectID: proj.ID,
		ParentID:  &tRoot.ID,
		Title:     "Compare train prices",
		Priority:  2,
	}
	if err := store.CreateTask(tSub); err != nil {
		t.Fatalf("failed to create subtask: %v", err)
	}

	// - Sub-subtask of tSub
	tSubSub := &db.Task{
		ProjectID: proj.ID,
		ParentID:  &tSub.ID,
		Title:     "Verify railcard discount",
		Priority:  3,
	}
	if err := store.CreateTask(tSubSub); err != nil {
		t.Fatalf("failed to create sub-subtask: %v", err)
	}

	// - Task inside section
	tSecTask := &db.Task{
		ProjectID:  proj.ID,
		SectionID:  &sec1.ID,
		Title:      "Pack suitcases",
		Priority:   3,
		Recurrence: &recDaily,
	}
	if err := store.CreateTask(tSecTask); err != nil {
		t.Fatalf("failed to create section task: %v", err)
	}

	// 4. Test Export
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/projects/export-csv?project_id=%s", proj.ID), nil)
	w := httptest.NewRecorder()
	api.handleExportCSV(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("export returned status %d", resp.StatusCode)
	}

	csvBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read export body: %v", err)
	}

	csvStr := string(csvBytes)
	if !strings.Contains(csvStr, "TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT") {
		t.Fatalf("export missing header: %s", csvStr)
	}
	if !strings.Contains(csvStr, "Buy train tickets") {
		t.Fatalf("export missing Buy train tickets: %s", csvStr)
	}
	if !strings.Contains(csvStr, "Central Station, London") {
		t.Fatalf("export missing location: %s", csvStr)
	}
	if !strings.Contains(csvStr, "Preparations") {
		t.Fatalf("export missing section: %s", csvStr)
	}

	// Read and verify rows
	reader := csv.NewReader(bytes.NewReader(csvBytes))
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatalf("failed to parse exported csv: %v", err)
	}

	// Verify indentation in records
	var foundSub, foundSubSub bool
	for _, row := range records {
		if len(row) >= 5 {
			if row[1] == "Compare train prices" && row[4] == "2" {
				foundSub = true
			}
			if row[1] == "Verify railcard discount" && row[4] == "3" {
				foundSubSub = true
			}
		}
	}
	if !foundSub || !foundSubSub {
		t.Fatalf("export failed to set correct indents: foundSub=%v, foundSubSub=%v", foundSub, foundSubSub)
	}

	// 5. Test Import into a second new project
	proj2 := &db.Project{Name: "Import Target"}
	if err := store.CreateProject(proj2); err != nil {
		t.Fatalf("failed to create target project: %v", err)
	}

	// Use multipart upload
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", "export.csv")
	if err != nil {
		t.Fatalf("failed to create form file: %v", err)
	}
	_, _ = part.Write(csvBytes)
	_ = writer.Close()

	reqImport := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/projects/import-csv?project_id=%s", proj2.ID), body)
	reqImport.Header.Set("Content-Type", writer.FormDataContentType())
	wImport := httptest.NewRecorder()
	api.handleImportCSV(wImport, reqImport)

	if wImport.Code != http.StatusOK {
		t.Fatalf("import returned status %d: %s", wImport.Code, wImport.Body.String())
	}

	// Verify imported data in proj2
	tasks2, err := store.ListProjectTasksForExport(proj2.ID)
	if err != nil {
		t.Fatalf("failed to list imported tasks: %v", err)
	}
	if len(tasks2) != 4 {
		t.Fatalf("expected 4 tasks imported, got %d", len(tasks2))
	}

	sections2, err := store.ListSections(proj2.ID)
	if err != nil {
		t.Fatalf("failed to list imported sections: %v", err)
	}
	if len(sections2) != 1 || sections2[0].Name != "Preparations" {
		t.Fatalf("expected section 'Preparations', got %v", sections2)
	}

	// Verify hierarchy preserved
	taskMap := make(map[string]*db.Task)
	for _, tsk := range tasks2 {
		taskMap[tsk.Title] = tsk
	}

	importedRoot := taskMap["Buy train tickets"]
	if importedRoot == nil || importedRoot.Location == nil || *importedRoot.Location != "Central Station, London" {
		t.Fatalf("root task location not preserved: %v", importedRoot)
	}

	importedSub := taskMap["Compare train prices"]
	if importedSub == nil || importedSub.ParentID == nil || *importedSub.ParentID != importedRoot.ID {
		t.Fatalf("subtask parent not linked to root: %v", importedSub)
	}

	importedSubSub := taskMap["Verify railcard discount"]
	if importedSubSub == nil || importedSubSub.ParentID == nil || *importedSubSub.ParentID != importedSub.ID {
		t.Fatalf("sub-subtask parent not linked to subtask: %v", importedSubSub)
	}
}

func TestCSVImportFrenchExcelDelimiterAndBOM(t *testing.T) {
	api, store := setupTestAPI(t)
	defer store.Close()

	proj := &db.Project{Name: "Excel Project"}
	if err := store.CreateProject(proj); err != nil {
		t.Fatalf("failed to create project: %v", err)
	}

	// CSV with UTF-8 BOM and semicolon delimiters
	csvWithBOM := "\xef\xbb\xbfTYPE;CONTENT;DESCRIPTION;PRIORITY;INDENT;AUTHOR;RESPONSIBLE;DATE;DATE_LANG;TIMEZONE\n" +
		"section;Section A;;1;1;;;;;\n" +
		"task;Task 1;Description 1;1;1;;;tomorrow;en;\n" +
		"task;Subtask 1.1;Location: 10 Downing Street, London;2;2;;;;;\n"

	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/projects/import-csv?project_id=%s", proj.ID), strings.NewReader(csvWithBOM))
	req.Header.Set("Content-Type", "text/csv")
	w := httptest.NewRecorder()
	api.handleImportCSV(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("import failed: %d %s", w.Code, w.Body.String())
	}

	tasks, err := store.ListProjectTasksForExport(proj.ID)
	if err != nil {
		t.Fatalf("failed to list tasks: %v", err)
	}
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(tasks))
	}

	if tasks[1].Location == nil || *tasks[1].Location != "10 Downing Street, London" {
		t.Fatalf("expected location '10 Downing Street, London', got %v", tasks[1].Location)
	}
}
