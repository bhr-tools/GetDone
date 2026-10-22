package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/ben/get-done/internal/api"
	"github.com/ben/get-done/internal/db"
)

func setupTestServer(t *testing.T) (*httptest.Server, *db.Store, func()) {
	t.Helper()
	tmpDir, err := os.MkdirTemp("", "get_done_api_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	dbPath := filepath.Join(tmpDir, "test.db")
	store, err := db.NewStore(dbPath)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create store: %v", err)
	}

	mux := http.NewServeMux()
	a := api.NewAPI(store)
	a.RegisterRoutes(mux)

	srv := httptest.NewServer(mux)

	cleanup := func() {
		srv.Close()
		store.Close()
		os.RemoveAll(tmpDir)
	}

	return srv, store, cleanup
}

func TestAPIRoutes(t *testing.T) {
	srv, _, cleanup := setupTestServer(t)
	defer cleanup()

	// 1. Create a Project
	projPayload := map[string]interface{}{
		"name": "NixOS Setup",
		"icon": "❄️",
	}
	body, _ := json.Marshal(projPayload)
	resp, err := http.Post(srv.URL+"/api/projects", "application/json", bytes.NewReader(body))
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Create project failed, status: %v", resp.StatusCode)
	}
	var createdProject db.Project
	_ = json.NewDecoder(resp.Body).Decode(&createdProject)
	resp.Body.Close()

	if createdProject.ID == "" || createdProject.Name != "NixOS Setup" {
		t.Errorf("Unexpected created project: %+v", createdProject)
	}

	// 2. Create a Task in this project
	taskPayload := map[string]interface{}{
		"project_id": createdProject.ID,
		"title":      "Write Flake configuration",
		"priority":   1,
		"location":   "Home",
	}
	body, _ = json.Marshal(taskPayload)
	resp, err = http.Post(srv.URL+"/api/tasks", "application/json", bytes.NewReader(body))
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Create task failed, status: %v", resp.StatusCode)
	}
	var createdTask db.Task
	_ = json.NewDecoder(resp.Body).Decode(&createdTask)
	resp.Body.Close()

	// 3. Complete the Task
	resp, err = http.Post(srv.URL+"/api/tasks/"+createdTask.ID+"/complete", "application/json", nil)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Complete task failed, status: %v", resp.StatusCode)
	}
	var completeRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&completeRes)
	resp.Body.Close()

	if completeRes["deleted"] != true {
		t.Errorf("Expected task to be deleted upon complete: %+v", completeRes)
	}

	// 4. Test QuickAdd Parse API
	parsePayload := map[string]string{
		"text": "Perform system update tomorrow 10am p2 #[NixOS Setup] @Office",
	}
	body, _ = json.Marshal(parsePayload)
	resp, err = http.Post(srv.URL+"/api/parse", "application/json", bytes.NewReader(body))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Parse quick add failed, status: %v", resp.StatusCode)
	}
	var parseRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&parseRes)
	resp.Body.Close()

	if parseRes["title"] != "Perform system update #[NixOS Setup]" {
		t.Errorf("Unexpected parsed title: %v", parseRes["title"])
	}
	if parseRes["project_name"] != nil {
		t.Errorf("Expected nil project_name, got: %v", parseRes["project_name"])
	}
	if parseRes["project_id"] != nil {
		t.Errorf("Expected nil project_id, got: %v", parseRes["project_id"])
	}
	if parseRes["priority"].(float64) != 2 {
		t.Errorf("Unexpected priority: %v", parseRes["priority"])
	}
}

func TestProjectSortAPI(t *testing.T) {
	srv, _, cleanup := setupTestServer(t)
	defer cleanup()

	client := &http.Client{}

	// 1. Create a Project
	projPayload, _ := json.Marshal(map[string]interface{}{
		"name": "Backend Development",
	})
	resp, err := client.Post(srv.URL+"/api/projects", "application/json", bytes.NewReader(projPayload))
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Create project failed: %v", err)
	}
	var proj db.Project
	_ = json.NewDecoder(resp.Body).Decode(&proj)
	resp.Body.Close()

	// 2. PATCH sort on custom project
	sortPayload, _ := json.Marshal(map[string]string{
		"sort_by":    "date",
		"sort_order": "desc",
	})
	req, _ := http.NewRequest(http.MethodPatch, srv.URL+"/api/projects/"+proj.ID+"/sort", bytes.NewReader(sortPayload))
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH project sort failed, status: %v", resp.StatusCode)
	}
	resp.Body.Close()

	// Verify via GET
	resp, err = client.Get(srv.URL + "/api/projects/" + proj.ID)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("GET project failed, status: %v", resp.StatusCode)
	}
	var fetchedProj db.Project
	_ = json.NewDecoder(resp.Body).Decode(&fetchedProj)
	resp.Body.Close()

	if fetchedProj.SortBy != "date" || fetchedProj.SortOrder != "desc" {
		t.Errorf("Expected date/desc sort, got %s/%s", fetchedProj.SortBy, fetchedProj.SortOrder)
	}

	// 3. PATCH sort on inbox
	inboxSortPayload, _ := json.Marshal(map[string]string{
		"sort_by":    "priority",
		"sort_order": "asc",
	})
	req, _ = http.NewRequest(http.MethodPatch, srv.URL+"/api/projects/inbox/sort", bytes.NewReader(inboxSortPayload))
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH inbox sort failed, status: %v", resp.StatusCode)
	}
	resp.Body.Close()

	// Verify inbox via GET
	resp, err = client.Get(srv.URL + "/api/projects/inbox")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("GET inbox failed, status: %v", resp.StatusCode)
	}
	var fetchedInbox db.Project
	_ = json.NewDecoder(resp.Body).Decode(&fetchedInbox)
	resp.Body.Close()

	if fetchedInbox.SortBy != "priority" || fetchedInbox.SortOrder != "asc" {
		t.Errorf("Expected priority/asc sort on inbox, got %s/%s", fetchedInbox.SortBy, fetchedInbox.SortOrder)
	}
}

func TestAuthFlow(t *testing.T) {
	srv, _, cleanup := setupTestServer(t)
	defer cleanup()

	client := &http.Client{}

	// 1. Initial status -> has_password: false, authenticated: false
	resp, err := client.Get(srv.URL + "/api/auth/status")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to get auth status: %v", err)
	}
	var status map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&status)
	resp.Body.Close()
	if status["has_password"] != false || status["authenticated"] != false {
		t.Errorf("Unexpected initial status: %+v", status)
	}

	// 2. Setup master password
	setupPayload, _ := json.Marshal(map[string]string{"password": "secret_master_password"})
	resp, err = client.Post(srv.URL+"/api/auth/setup", "application/json", bytes.NewReader(setupPayload))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Setup password failed: %v", err)
	}
	// Extract session cookie
	var sessionCookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "todo_session" {
			sessionCookie = c
			break
		}
	}
	resp.Body.Close()
	if sessionCookie == nil || sessionCookie.Value == "" {
		t.Fatalf("Expected todo_session cookie after setup")
	}

	// 3. Status with cookie -> authenticated: true
	req, _ := http.NewRequest("GET", srv.URL+"/api/auth/status", nil)
	req.AddCookie(sessionCookie)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Status with cookie failed: %v", err)
	}
	_ = json.NewDecoder(resp.Body).Decode(&status)
	resp.Body.Close()
	if status["has_password"] != true || status["authenticated"] != true {
		t.Errorf("Expected authenticated status, got: %+v", status)
	}

	// 4. Request without cookie to protected route -> 401 Unauthorized
	resp, err = client.Get(srv.URL + "/api/projects")
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 without cookie, got: %v", resp.StatusCode)
	}
	resp.Body.Close()

	// 5. Request with cookie to protected route -> 200 OK
	req, _ = http.NewRequest("GET", srv.URL+"/api/projects", nil)
	req.AddCookie(sessionCookie)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200 with cookie, got: %v", resp.StatusCode)
	}
	resp.Body.Close()

	// 6. Test login with wrong password -> 401
	badLogin, _ := json.Marshal(map[string]string{"password": "wrong"})
	resp, err = client.Post(srv.URL+"/api/auth/login", "application/json", bytes.NewReader(badLogin))
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 for wrong password, got: %v", resp.StatusCode)
	}
	resp.Body.Close()

	// 7. Test login with correct password -> 200 + new cookie
	goodLogin, _ := json.Marshal(map[string]string{"password": "secret_master_password"})
	resp, err = client.Post(srv.URL+"/api/auth/login", "application/json", bytes.NewReader(goodLogin))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200 for good password, got: %v", resp.StatusCode)
	}
	resp.Body.Close()

	// 8. Test change password
	changePayload, _ := json.Marshal(map[string]string{
		"old_password": "secret_master_password",
		"new_password": "new_super_secret",
	})
	req, _ = http.NewRequest("POST", srv.URL+"/api/auth/change-password", bytes.NewReader(changePayload))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(sessionCookie)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Change password failed: %v", err)
	}
	resp.Body.Close()

	// 9. Login with new password succeeds
	newLogin, _ := json.Marshal(map[string]string{"password": "new_super_secret"})
	resp, err = client.Post(srv.URL+"/api/auth/login", "application/json", bytes.NewReader(newLogin))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Login with new password failed: %v", err)
	}
	resp.Body.Close()
}
