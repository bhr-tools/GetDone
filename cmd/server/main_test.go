package main

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ben/get-done/internal/db"
)

func TestHandlerRoutes(t *testing.T) {
	store, err := db.Open(filepath.Join(t.TempDir(), "main.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	h := newHandler(store, true)

	tests := []struct {
		path, wantBody string
		wantStatus     int
	}{
		{"/", "<title>Get Done</title>", 200},
		{"/js/app.js", "class App", 200},
		{"/css/style.css", "rose-pine.css", 200},
		{"/healthz", "ok", 200},
		{"/api/projects", "[]", 200},
		{"/embed.go", "", 404}, // source files are not served
		{"/api/unknown", "Unknown API endpoint", 404},
	}
	for _, tt := range tests {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", tt.path, nil))
		if rec.Code != tt.wantStatus || !strings.Contains(rec.Body.String(), tt.wantBody) {
			t.Errorf("GET %s = %d %.80q, want %d containing %q", tt.path, rec.Code, rec.Body.String(), tt.wantStatus, tt.wantBody)
		}
		if rec.Header().Get("Content-Security-Policy") == "" {
			t.Errorf("GET %s: missing security headers", tt.path)
		}
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/js/app.js", nil))
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Error("web assets must be revalidated")
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Errorf("app.js Content-Type = %q", ct)
	}
}
