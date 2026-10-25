package api

import (
	"net/http"

	"github.com/ben/get-done/internal/db"
	"github.com/ben/get-done/internal/parser"
)

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

func (a *API) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := a.store.ListProjects()
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, projects)
}

func (a *API) getProject(w http.ResponseWriter, r *http.Request) {
	p, err := a.store.GetProject(r.PathValue("id"))
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (a *API) createProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string  `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	p, err := a.store.CreateProject(req.Name, req.ParentID)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (a *API) renameProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &req) {
		return
	}
	p, err := a.store.RenameProject(r.PathValue("id"), req.Name)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (a *API) deleteProject(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteProject(r.PathValue("id")); err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (a *API) moveProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ParentID *string `json:"parent_id"`
		db.Placement
	}
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.MoveProject(r.PathValue("id"), req.ParentID, req.Placement); err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"moved": true})
}

func (a *API) setProjectSort(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SortBy string `json:"sort_by"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.SetProjectSort(r.PathValue("id"), req.SortBy); err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sort_by": req.SortBy})
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

func (a *API) listSections(w http.ResponseWriter, r *http.Request) {
	projectID := r.URL.Query().Get("project_id")
	if projectID == "" {
		writeError(w, http.StatusBadRequest, "project_id is required")
		return
	}
	sections, err := a.store.ListSections(projectID)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sections)
}

func (a *API) createSection(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProjectID string `json:"project_id"`
		Name      string `json:"name"`
	}
	if !decode(w, r, &req) {
		return
	}
	sec, err := a.store.CreateSection(req.ProjectID, req.Name)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, sec)
}

func (a *API) renameSection(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &req) {
		return
	}
	sec, err := a.store.RenameSection(r.PathValue("id"), req.Name)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sec)
}

func (a *API) deleteSection(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteSection(r.PathValue("id")); err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (a *API) moveSection(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProjectID string `json:"project_id"`
		db.Placement
	}
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.MoveSection(r.PathValue("id"), req.ProjectID, req.Placement); err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"moved": true})
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

func (a *API) listTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tasks, err := a.store.ListTasks(db.TaskFilter{
		View:      q.Get("view"),
		ProjectID: q.Get("project_id"),
		Sort:      q.Get("sort"),
		Today:     parser.NormalizeToday(q.Get("today")),
	})
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (a *API) getTask(w http.ResponseWriter, r *http.Request) {
	t, err := a.store.GetTask(r.PathValue("id"))
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (a *API) createTask(w http.ResponseWriter, r *http.Request) {
	var in db.NewTask
	if !decode(w, r, &in) {
		return
	}
	t, err := a.store.CreateTask(in)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (a *API) updateTask(w http.ResponseWriter, r *http.Request) {
	var p db.TaskPatch
	if !decode(w, r, &p) {
		return
	}
	t, err := a.store.UpdateTask(r.PathValue("id"), p)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (a *API) moveTask(w http.ResponseWriter, r *http.Request) {
	var m db.TaskMove
	if !decode(w, r, &m) {
		return
	}
	t, err := a.store.MoveTask(r.PathValue("id"), m)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (a *API) deleteTask(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteTask(r.PathValue("id")); err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (a *API) completeTask(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Today string `json:"today"`
	}
	if r.ContentLength != 0 && !decode(w, r, &req) {
		return
	}
	c, err := a.store.CompleteTask(r.PathValue("id"), parser.NormalizeToday(req.Today))
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *API) restoreTasks(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Tasks   []*db.Task         `json:"tasks"`
		Updates []db.RestoreUpdate `json:"updates"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.RestoreTasks(req.Tasks, req.Updates); err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"restored": true})
}

func (a *API) search(w http.ResponseWriter, r *http.Request) {
	tasks, err := a.store.SearchTasks(r.URL.Query().Get("q"))
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (a *API) counts(w http.ResponseWriter, r *http.Request) {
	c, err := a.store.Counts(r.URL.Query().Get("today"))
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}
