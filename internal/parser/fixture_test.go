package parser

import (
	"encoding/json"
	"os"
	"testing"
)

// The JavaScript port (web/js/recurrence.js) is tested against the same file:
// the Go code is the reference, never change it to match the JavaScript.
type fixture struct {
	Next []struct {
		Due   string `json:"due"`
		Rule  string `json:"rule"`
		Today string `json:"today"`
		Want  string `json:"want"`
	} `json:"next"`
	Valid []struct {
		Rule  string `json:"rule"`
		Valid bool   `json:"valid"`
	} `json:"valid"`
	DueValid []struct {
		Due   string `json:"due"`
		Valid bool   `json:"valid"`
	} `json:"due_valid"`
}

func TestFixture(t *testing.T) {
	b, err := os.ReadFile("../../tests/fixtures/next_due.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Next {
		if got := NextDueDate(c.Due, c.Rule, c.Today); got != c.Want {
			t.Errorf("NextDueDate(%q, %q, %q) = %q, want %q", c.Due, c.Rule, c.Today, got, c.Want)
		}
	}
	for _, c := range f.Valid {
		if got := ValidRecurrence(c.Rule); got != c.Valid {
			t.Errorf("ValidRecurrence(%q) = %v, want %v", c.Rule, got, c.Valid)
		}
	}
	for _, c := range f.DueValid {
		if got := ValidDue(c.Due); got != c.Valid {
			t.Errorf("ValidDue(%q) = %v, want %v", c.Due, got, c.Valid)
		}
	}
}
