package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ben/get-done/internal/db"
)

// An app connected to a project adds tasks there and reads them, and
// nothing else; deleting the project or the app disconnects it.
func TestConnectedApp(t *testing.T) {
	c, _ := newClient(t, false)
	c.do("POST", "/api/auth/setup", map[string]any{"password": "secret"}, 200, nil)
	back := "https://assistant.example.com/api/getdone/callback"

	c.do("POST", "/api/connect", map[string]any{"app": "Assistant", "redirect_uri": "javascript:x", "new_project": "Assistant"}, 400, nil)
	var code struct{ Code string }
	c.do("POST", "/api/connect", map[string]any{"app": "Assistant", "redirect_uri": back, "new_project": "Assistant"}, 200, &code)
	var tok struct {
		Token       string `json:"token"`
		ProjectID   string `json:"project_id"`
		ProjectName string `json:"project_name"`
	}
	c.do("POST", "/api/connect/token", map[string]any{"code": code.Code, "redirect_uri": "https://evil.example.com/"}, 400, nil)
	c.do("POST", "/api/connect", map[string]any{"app": "Assistant", "redirect_uri": back, "new_project": "Assistant"}, 200, &code)
	c.do("POST", "/api/connect/token", map[string]any{"code": code.Code, "redirect_uri": back}, 200, &tok)
	if tok.Token == "" || tok.ProjectName != "Assistant" {
		t.Fatalf("token: %+v", tok)
	}
	c.do("POST", "/api/connect/token", map[string]any{"code": code.Code, "redirect_uri": back}, 400, nil) // one use

	app := func(method, path, body string, want int) string {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok.Token)
		rec := httptest.NewRecorder()
		c.handler.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s = %d, want %d: %s", method, path, rec.Code, want, rec.Body)
		}
		return rec.Body.String()
	}
	if got := app("GET", "/api/app/info", "", 200); !strings.Contains(got, `"name":"Assistant"`) || !strings.Contains(got, `"scope":"project"`) {
		t.Fatalf("app info: %s", got)
	}
	app("POST", "/api/app/tasks", `{"title":"Follow up: Optiver","description":"Sent to HR","due_date":"2026-11-20"}`, 201)
	app("POST", "/api/app/tasks", `{"title":"x","due_date":"soon"}`, 400)
	if got := app("GET", "/api/app/tasks", "", 200); !strings.Contains(got, `"title":"Follow up: Optiver"`) || !strings.Contains(got, `"due_date":"2026-11-20"`) {
		t.Fatalf("app tasks: %s", got)
	}
	// The token opens nothing else.
	app("GET", "/api/tasks?view=inbox", "", 401)
	app("GET", "/api/projects", "", 401)

	var apps []db.App
	c.do("GET", "/api/apps", nil, 200, &apps)
	if len(apps) != 1 || apps[0].ProjectName != "Assistant" || apps[0].UsedAt == nil {
		t.Fatalf("apps: %+v", apps)
	}
	c.do("DELETE", "/api/projects/"+tok.ProjectID, nil, 200, nil)
	app("GET", "/api/app/tasks", "", http.StatusUnauthorized)
	app("GET", "/api/app/info", "", http.StatusUnauthorized)
	c.do("GET", "/api/apps", nil, 200, &apps)
	if len(apps) != 0 {
		t.Fatalf("the app goes with its project: %+v", apps)
	}
}
