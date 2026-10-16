package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/ben/get-done/internal/db"
	"github.com/ben/get-done/internal/parser"
)

type API struct {
	store  *db.Store
	noAuth bool
}

func NewAPI(store *db.Store, args ...interface{}) *API {
	a := &API{store: store}
	for _, arg := range args {
		switch v := arg.(type) {
		case bool:
			a.noAuth = v
		}
	}
	return a
}

func (a *API) RegisterRoutes(mux *http.ServeMux) {
	// Auth routes
	mux.HandleFunc("/api/auth/status", a.handleAuthStatus)
	mux.HandleFunc("/api/auth/setup", a.handleAuthSetup)
	mux.HandleFunc("/api/auth/login", a.handleAuthLogin)
	mux.HandleFunc("/api/auth/logout", a.handleAuthLogout)
	mux.HandleFunc("/api/auth/change-password", a.authMiddleware(a.handleAuthChangePassword))

	// App routes (protected)
	mux.HandleFunc("/api/projects/export-csv", a.authMiddleware(a.handleExportCSV))
	mux.HandleFunc("/api/projects/import-csv", a.authMiddleware(a.handleImportCSV))
	mux.HandleFunc("/api/projects/reorder", a.authMiddleware(a.handleProjectsReorder))
	mux.HandleFunc("/api/projects", a.authMiddleware(a.handleProjects))
	mux.HandleFunc("/api/projects/", a.authMiddleware(a.handleProjectItem))

	mux.HandleFunc("/api/sections", a.authMiddleware(a.handleSections))
	mux.HandleFunc("/api/sections/", a.authMiddleware(a.handleSectionItem))

	mux.HandleFunc("/api/tasks/reorder", a.authMiddleware(a.handleTasksReorder))
	mux.HandleFunc("/api/tasks/restore", a.authMiddleware(a.handleTasksRestore))
	mux.HandleFunc("/api/tasks", a.authMiddleware(a.handleTasks))
	mux.HandleFunc("/api/tasks/", a.authMiddleware(a.handleTaskItem))

	mux.HandleFunc("/api/search", a.authMiddleware(a.handleSearch))
	mux.HandleFunc("/api/parse", a.authMiddleware(a.handleParseQuickAdd))
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if data != nil {
		_ = json.NewEncoder(w).Encode(data)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// ----------------------------------------------------------------------
// Projects Handlers
// ----------------------------------------------------------------------

func (a *API) handleProjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		projects, err := a.store.ListProjects()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if projects == nil {
			projects = make([]*db.Project, 0)
		}
		writeJSON(w, http.StatusOK, projects)

	case http.MethodPost:
		var p db.Project
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if strings.TrimSpace(p.Name) == "" {
			writeError(w, http.StatusBadRequest, "project name is required")
			return
		}
		if err := a.store.CreateProject(&p); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, p)

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *API) handleProjectItem(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/projects/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing project id")
		return
	}

	if strings.HasSuffix(id, "/sort") {
		projectID := strings.TrimSuffix(id, "/sort")
		if projectID == "" {
			writeError(w, http.StatusBadRequest, "missing project id")
			return
		}
		if r.Method != http.MethodPatch && r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var payload struct {
			SortBy    string `json:"sort_by"`
			SortOrder string `json:"sort_order"`
			Sort      string `json:"sort"`
			Order     string `json:"order"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if payload.SortBy == "" && payload.Sort != "" {
			payload.SortBy = payload.Sort
		}
		if payload.SortOrder == "" && payload.Order != "" {
			payload.SortOrder = payload.Order
		}
		if payload.SortBy == "" {
			payload.SortBy = "manual"
		}
		if payload.SortOrder == "" {
			payload.SortOrder = "asc"
		}
		if err := a.store.UpdateProjectSort(projectID, payload.SortBy, payload.SortOrder); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"id":         projectID,
			"sort_by":    payload.SortBy,
			"sort_order": payload.SortOrder,
		})
		return
	}

	switch r.Method {
	case http.MethodGet:
		p, err := a.store.GetProject(id)
		if err != nil {
			writeError(w, http.StatusNotFound, "project not found")
			return
		}
		writeJSON(w, http.StatusOK, p)

	case http.MethodPut, http.MethodPatch:
		var p db.Project
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		p.ID = id
		if err := a.store.UpdateProject(&p); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, p)

	case http.MethodDelete:
		if err := a.store.DeleteProject(id); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *API) handleProjectsReorder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var items []db.ReorderProjectItem
	if err := json.NewDecoder(r.Body).Decode(&items); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := a.store.ReorderProjects(items); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// ----------------------------------------------------------------------
// Sections Handlers
// ----------------------------------------------------------------------

func (a *API) handleSections(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		projectID := r.URL.Query().Get("project_id")
		if projectID == "" {
			writeError(w, http.StatusBadRequest, "project_id is required")
			return
		}
		sections, err := a.store.ListSections(projectID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if sections == nil {
			sections = make([]*db.Section, 0)
		}
		writeJSON(w, http.StatusOK, sections)

	case http.MethodPost:
		var sec db.Section
		if err := json.NewDecoder(r.Body).Decode(&sec); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if strings.TrimSpace(sec.Name) == "" || sec.ProjectID == "" {
			writeError(w, http.StatusBadRequest, "name and project_id are required")
			return
		}
		if err := a.store.CreateSection(&sec); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, sec)

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *API) handleSectionItem(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/sections/")
	parts := strings.Split(path, "/")
	id := parts[0]

	if id == "" {
		writeError(w, http.StatusBadRequest, "missing section id")
		return
	}

	if len(parts) > 1 && parts[1] == "move" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			ProjectID string `json:"project_id"`
			Position  int    `json:"position"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if err := a.store.MoveSection(id, body.ProjectID, body.Position); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"success": true})
		return
	}

	switch r.Method {
	case http.MethodPut, http.MethodPatch:
		var sec db.Section
		if err := json.NewDecoder(r.Body).Decode(&sec); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		sec.ID = id
		if err := a.store.UpdateSection(&sec); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, sec)

	case http.MethodDelete:
		if err := a.store.DeleteSection(id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// ----------------------------------------------------------------------
// Tasks Handlers
// ----------------------------------------------------------------------

func (a *API) handleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		view := r.URL.Query().Get("view")
		projectID := r.URL.Query().Get("project_id")
		if view == "" {
			if projectID != "" {
				view = "project"
			} else {
				view = "upcoming"
			}
		}
		sectionID := r.URL.Query().Get("section_id")
		sortBy := r.URL.Query().Get("sort")
		sortOrder := r.URL.Query().Get("order")

		filter := db.TaskFilter{
			View:      view,
			ProjectID: projectID,
			SectionID: sectionID,
			SortBy:    sortBy,
			SortOrder: sortOrder,
			Now:       time.Now(),
		}

		tasks, err := a.store.ListTasks(filter)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if tasks == nil {
			tasks = make([]*db.Task, 0)
		}
		writeJSON(w, http.StatusOK, tasks)

	case http.MethodPost:
		var t db.Task
		if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if strings.TrimSpace(t.Title) == "" {
			writeError(w, http.StatusBadRequest, "task title is required")
			return
		}

		if err := a.store.CreateTask(&t); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, t)

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *API) handleTasksReorder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var items []db.ReorderTaskItem
	if err := json.NewDecoder(r.Body).Decode(&items); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := a.store.ReorderTasks(items); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *API) handleTasksRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var payload struct {
		Tasks   []*db.Task         `json:"tasks"`
		Updates []db.RestoreUpdate `json:"updates"`
	}

	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if err := a.store.RestoreTasks(payload.Tasks, payload.Updates); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"restored": true})
}

func (a *API) handleTaskItem(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	parts := strings.Split(path, "/")
	id := parts[0]

	if id == "" {
		writeError(w, http.StatusBadRequest, "missing task id")
		return
	}

	if len(parts) > 1 {
		action := parts[1]
		switch action {
		case "complete":
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			existingTask, _ := a.store.GetTask(id)
			var prevDueDate *string
			if existingTask != nil && existingTask.DueDate != nil {
				prevDueDate = existingTask.DueDate
			}

			updatedTask, wasDeleted, err := a.store.CompleteTask(id, parser.NextDueDate, time.Now())
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"deleted":           wasDeleted,
				"task":              updatedTask,
				"previous_due_date": prevDueDate,
			})
			return

		case "postpone":
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			var body struct {
				Days int `json:"days"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Days == 0 {
				body.Days = 1
			}
			if err := a.store.PostponeTask(id, body.Days, time.Now()); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			task, _ := a.store.GetTask(id)
			writeJSON(w, http.StatusOK, task)
			return

		case "indent":
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			var body struct {
				SiblingID string `json:"sibling_id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if err := a.store.IndentTask(id, body.SiblingID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			task, _ := a.store.GetTask(id)
			writeJSON(w, http.StatusOK, task)
			return

		case "outdent":
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			if err := a.store.OutdentTask(id); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			task, _ := a.store.GetTask(id)
			writeJSON(w, http.StatusOK, task)
			return

		default:
			writeError(w, http.StatusNotFound, "unknown task action")
			return
		}
	}

	switch r.Method {
	case http.MethodGet:
		task, err := a.store.GetTask(id)
		if err != nil {
			writeError(w, http.StatusNotFound, "task not found")
			return
		}
		writeJSON(w, http.StatusOK, task)

	case http.MethodPut, http.MethodPatch:
		var updates map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		updatedTask, err := a.store.PatchTask(id, updates)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, updatedTask)

	case http.MethodDelete:
		if err := a.store.DeleteTask(id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// ----------------------------------------------------------------------
// Quick Add Parser Preview
// ----------------------------------------------------------------------

func (a *API) handleParseQuickAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	parsed := parser.ParseQuickAdd(body.Text, time.Now())

	var targetProjectID *string
	if parsed.ProjectName != nil {
		projects, err := a.store.ListProjects()
		if err == nil {
			targetProjectID = findProjectIDByName(projects, *parsed.ProjectName)
		}
	}

	response := map[string]interface{}{
		"title":        parsed.Title,
		"priority":     parsed.Priority,
		"due_date":     parsed.DueDate,
		"recurrence":   parsed.Recurrence,
		"location":     parsed.Location,
		"project_name": parsed.ProjectName,
		"project_id":   targetProjectID,
	}

	writeJSON(w, http.StatusOK, response)
}

func findProjectIDByName(projects []*db.Project, name string) *string {
	lower := strings.ToLower(name)
	if lower == "inbox" || lower == "boîte de réception" {
		inbox := "inbox"
		return &inbox
	}
	for _, p := range projects {
		if strings.ToLower(p.Name) == lower {
			return &p.ID
		}
		if len(p.Children) > 0 {
			if id := findProjectIDByName(p.Children, name); id != nil {
				return id
			}
		}
	}
	return nil
}

func (a *API) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, http.StatusOK, []*db.Task{})
		return
	}

	tasks, err := a.store.SearchTasks(query)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if tasks == nil {
		tasks = make([]*db.Task, 0)
	}
	writeJSON(w, http.StatusOK, tasks)
}

// ----------------------------------------------------------------------
// Authentication Middleware & Handlers
// ----------------------------------------------------------------------

func (a *API) authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.noAuth {
			next(w, r)
			return
		}
		hasPwd, err := a.store.HasPassword()
		if err != nil || !hasPwd {
			// No password setup yet -> allow through
			next(w, r)
			return
		}

		cookie, err := r.Cookie("todo_session")
		if err != nil || cookie.Value == "" || !a.store.ValidateSession(cookie.Value) {
			writeJSON(w, http.StatusUnauthorized, map[string]interface{}{
				"error":         "Authentication required",
				"auth_required": true,
			})
			return
		}

		next(w, r)
	}
}

func (a *API) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if a.noAuth {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"has_password":  false,
			"authenticated": true,
			"no_auth":       true,
		})
		return
	}

	hasPwd, err := a.store.HasPassword()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	isAuth := false
	if !hasPwd {
		isAuth = false
	} else {
		if cookie, err := r.Cookie("todo_session"); err == nil && cookie.Value != "" {
			isAuth = a.store.ValidateSession(cookie.Value)
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"has_password":  hasPwd,
		"authenticated": isAuth,
	})
}

func (a *API) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	hasPwd, err := a.store.HasPassword()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if hasPwd {
		http.Error(w, "Password already configured", http.StatusBadRequest)
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Password) == "" {
		http.Error(w, "Password is required", http.StatusBadRequest)
		return
	}

	if err := a.store.SetPassword(strings.TrimSpace(req.Password)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	token, err := a.store.CreateSession()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "todo_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   30 * 24 * 3600, // 30 days
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"authenticated": true,
	})
}

func (a *API) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	valid, err := a.store.VerifyPassword(req.Password)
	if err != nil || !valid {
		writeJSON(w, http.StatusUnauthorized, map[string]interface{}{
			"error": "Invalid password",
		})
		return
	}

	token, err := a.store.CreateSession()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "todo_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   30 * 24 * 3600, // 30 days
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"authenticated": true,
	})
}

func (a *API) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if cookie, err := r.Cookie("todo_session"); err == nil && cookie.Value != "" {
		_ = a.store.DeleteSession(cookie.Value)
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "todo_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"authenticated": false,
	})
}

func (a *API) handleAuthChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.NewPassword) == "" {
		http.Error(w, "New password is required", http.StatusBadRequest)
		return
	}

	hasPwd, _ := a.store.HasPassword()
	if hasPwd {
		valid, err := a.store.VerifyPassword(req.OldPassword)
		if err != nil || !valid {
			writeJSON(w, http.StatusUnauthorized, map[string]interface{}{
				"error": "Current password is incorrect",
			})
			return
		}
	}

	if err := a.store.SetPassword(strings.TrimSpace(req.NewPassword)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	_ = a.store.DeleteAllSessions()
	token, _ := a.store.CreateSession()

	http.SetCookie(w, &http.Cookie{
		Name:     "todo_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   30 * 24 * 3600,
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
	})
}


