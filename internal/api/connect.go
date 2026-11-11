package api

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ben/get-done/internal/db"
)

// Connecting an app (the Assistant…) to Get Done, in the manner of OAuth:
//
//  1. the app sends the user to /?connect=<name>&redirect_uri=<url>&state=<s>;
//  2. Get Done asks the user, logged in, which project the app may add tasks
//     to (an existing one, or a new one named after the app);
//  3. on Allow, the page gets a one-time code (POST /api/connect) and goes
//     back to redirect_uri?code=…&state=…;
//  4. the app's server trades the code for a lasting token
//     (POST /api/connect/token), sent to it only, never to the browser.
//
// An app token adds tasks to its project and reads them (/api/app/tasks),
// and says what it opens (/api/app/info, the same in each of the user's
// apps), nothing else. The user disconnects the app from Security → Connected apps
// (or by deleting the project); the app may leave (DELETE /api/connect).

const codeTTL = 5 * time.Minute

type connectCode struct {
	app, project, redirect string
	expires                time.Time
}

type connectCodes struct {
	mu    sync.Mutex
	codes map[string]connectCode
}

// validRedirect accepts an absolute http(s) address.
func validRedirect(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.Fragment == ""
}

// connect gives the logged-in user's page a one-time code for an app, bound
// to the project chosen (or to a new project, when project_id is empty).
func (a *API) connect(w http.ResponseWriter, r *http.Request) {
	var req struct {
		App         string `json:"app"`
		RedirectURI string `json:"redirect_uri"`
		ProjectID   string `json:"project_id"`
		NewProject  string `json:"new_project"`
	}
	if !decode(w, r, &req) {
		return
	}
	req.App = strings.TrimSpace(req.App)
	if req.App == "" || len(req.App) > 60 {
		writeError(w, http.StatusBadRequest, "The app needs a name of at most 60 characters")
		return
	}
	if !validRedirect(req.RedirectURI) {
		writeError(w, http.StatusBadRequest, "The app gave no valid address to come back to")
		return
	}
	project := req.ProjectID
	if project == "" {
		p, err := a.store.CreateProject("", req.NewProject, nil)
		if err != nil {
			fail(w, r, err)
			return
		}
		project = p.ID
	} else if _, err := a.store.GetProject(project); err != nil {
		fail(w, r, err)
		return
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		fail(w, r, err)
		return
	}
	code := hex.EncodeToString(b)
	now := time.Now()
	a.codes.mu.Lock()
	if a.codes.codes == nil {
		a.codes.codes = map[string]connectCode{}
	}
	for c, p := range a.codes.codes {
		if now.After(p.expires) {
			delete(a.codes.codes, c)
		}
	}
	a.codes.codes[code] = connectCode{app: req.App, project: project, redirect: req.RedirectURI, expires: now.Add(codeTTL)}
	a.codes.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}

// connectToken trades a one-time code for an app token.
func (a *API) connectToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code        string `json:"code"`
		RedirectURI string `json:"redirect_uri"`
	}
	if !decode(w, r, &req) {
		return
	}
	a.codes.mu.Lock()
	p, ok := a.codes.codes[req.Code]
	delete(a.codes.codes, req.Code) // one use, right or wrong
	a.codes.mu.Unlock()
	if !ok || time.Now().After(p.expires) || p.redirect != req.RedirectURI {
		writeError(w, http.StatusBadRequest, "Unknown or expired code: connect again")
		return
	}
	token, err := a.store.CreateAppToken(p.app, p.project)
	if err != nil {
		fail(w, r, err)
		return
	}
	project, err := a.store.GetProject(p.project)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token, "project_id": project.ID, "project_name": project.Name})
}

func bearer(r *http.Request) string {
	tok, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return tok
}

// disconnectSelf lets an app give its token back.
func (a *API) disconnectSelf(w http.ResponseWriter, r *http.Request) {
	if bearer(r) == "" {
		writeError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if err := a.store.DeleteAppToken(bearer(r)); err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) listApps(w http.ResponseWriter, r *http.Request) {
	apps, err := a.store.ListApps()
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, apps)
}

func (a *API) deleteApp(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Unknown app")
		return
	}
	if err := a.store.DeleteApp(id); err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// appProject passes the project of a valid app token to next.
func (a *API) appProject(next func(w http.ResponseWriter, r *http.Request, project string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		project, ok := a.store.AppProject(bearer(r))
		if !ok {
			writeError(w, http.StatusUnauthorized, "This app is not connected (any more): connect it again")
			return
		}
		next(w, r, project)
	}
}

// appInfo is the same in each of the user's apps: which app answers, and
// what the token opens (here: one project, by id and name). An app checks
// with it that its access still works.
func (a *API) appInfo(w http.ResponseWriter, r *http.Request, project string) {
	p, err := a.store.GetProject(project)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"app": "GetDone", "scope": "project", "id": p.ID, "name": p.Name})
}

// appTask is what an app sees of a task of its project.
type appTask struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	DueDate     *string `json:"due_date"`
}

// appTasks lists the open tasks of the app's project (subtasks included),
// by due date.
func (a *API) appTasks(w http.ResponseWriter, r *http.Request, project string) {
	tree, err := a.store.ListTasks(db.TaskFilter{View: "project", ProjectID: project, Sort: "date"})
	if err != nil {
		fail(w, r, err)
		return
	}
	out := []appTask{}
	var walk func(ts []*db.Task)
	walk = func(ts []*db.Task) {
		for _, t := range ts {
			out = append(out, appTask{ID: t.ID, Title: t.Title, Description: t.Description, DueDate: t.DueDate})
			walk(t.Subtasks)
		}
	}
	walk(tree)
	writeJSON(w, http.StatusOK, out)
}

// appCreateTask adds a task to the app's project.
func (a *API) appCreateTask(w http.ResponseWriter, r *http.Request, project string) {
	var in struct {
		Title       string  `json:"title"`
		Description string  `json:"description"`
		DueDate     *string `json:"due_date"`
	}
	if !decode(w, r, &in) {
		return
	}
	t, err := a.store.CreateTask(db.NewTask{ProjectID: project, Title: in.Title, Description: in.Description, DueDate: in.DueDate})
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, appTask{ID: t.ID, Title: t.Title, Description: t.Description, DueDate: t.DueDate})
}
