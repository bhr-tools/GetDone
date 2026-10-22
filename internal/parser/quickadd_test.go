package parser

import (
	"testing"
	"time"
)

func TestParseQuickAdd(t *testing.T) {
	refTime := time.Date(2026, 10, 7, 10, 0, 0, 0, time.UTC) // Wednesday, Oct 7, 2026

	tests := []struct {
		name         string
		input        string
		wantTitle    string
		wantPriority int
		wantDueDate  string
		wantRecurr   string
		wantLocation string
	}{
		{
			name:         "Basic task with priority and #Tag",
			input:        "Acheter du pain #Courses p1",
			wantTitle:    "Acheter du pain #Courses",
			wantPriority: 1,
		},
		{
			name:         "Task with tomorrow date and time and #Tag",
			input:        "Rendez-vous dentiste demain 14h30 #Perso p2",
			wantTitle:    "Rendez-vous dentiste #Perso",
			wantPriority: 2,
			wantDueDate:  "2026-10-08 14:30",
		},
		{
			name:         "Task with recurrence and location",
			input:        "Réunion d'équipe @Salle 204 tous les lundis 09:00",
			wantTitle:    "Réunion d'équipe",
			wantPriority: 3,
			wantDueDate:  "2026-10-12 09:00",
			wantRecurr:   "weekly:monday",
			wantLocation: "Salle 204",
		},
		{
			name:         "Task with exclamation priority and daily",
			input:        "Faire du sport chaque jour !3",
			wantTitle:    "Faire du sport",
			wantPriority: 3,
			wantRecurr:   "daily",
		},
		{
			name:        "Month Day in English (october 23)",
			input:       "Review roadmap october 23 p1",
			wantTitle:   "Review roadmap",
			wantPriority: 1,
			wantDueDate: "2026-10-23",
		},
		{
			name:        "Day Month in English (23 october)",
			input:       "Team retrospective 23 october",
			wantTitle:   "Team retrospective",
			wantPriority: 3,
			wantDueDate: "2026-10-23",
		},
		{
			name:        "Day Month abbreviated English (23 oct)",
			input:       "Ship feature 23 oct 18:00",
			wantTitle:   "Ship feature",
			wantPriority: 3,
			wantDueDate: "2026-10-23 18:00",
		},
		{
			name:        "Day Month in French (23 octobre)",
			input:       "Release notes 23 octobre",
			wantTitle:   "Release notes",
			wantPriority: 3,
			wantDueDate: "2026-10-23",
		},
		{
			name:        "Month Day in French (octobre 23)",
			input:       "Client demo octobre 23",
			wantTitle:   "Client demo",
			wantPriority: 3,
			wantDueDate: "2026-10-23",
		},
		{
			name:        "Abbreviated November in English (12 nov)",
			input:       "Quarterly planning 12 nov",
			wantTitle:   "Quarterly planning",
			wantPriority: 3,
			wantDueDate: "2026-11-12",
		},
		{
			name:        "French month with accent (15 décembre)",
			input:       "Year end review 15 décembre",
			wantTitle:   "Year end review",
			wantPriority: 3,
			wantDueDate: "2026-12-15",
		},
		{
			name:        "Passed date in current year wraps to next year (5 oct)",
			input:       "Annual tax report 5 oct",
			wantTitle:   "Annual tax report",
			wantPriority: 3,
			wantDueDate: "2027-10-05",
		},
		{
			name:        "Short weekday in English (fri)",
			input:       "Team sync fri",
			wantTitle:   "Team sync",
			wantPriority: 3,
			wantDueDate: "2026-10-09",
		},
		{
			name:        "Month day abbreviated (nov 12)",
			input:       "Sprint review nov 12",
			wantTitle:   "Sprint review",
			wantPriority: 3,
			wantDueDate: "2026-11-12",
		},
		{
			name:        "Tomorrow with 24h time (tomorrow 14:00)",
			input:       "Deploy app tomorrow 14:00",
			wantTitle:   "Deploy app",
			wantPriority: 3,
			wantDueDate: "2026-10-08 14:00",
		},
		{
			name:        "Weekend keyword (this weekend)",
			input:       "Hiking trip this weekend",
			wantTitle:   "Hiking trip",
			wantPriority: 3,
			wantDueDate: "2026-10-10",
		},
		{
			name:        "Passed date in French wraps to next year (15 janvier)",
			input:       "Contract renewal 15 janvier",
			wantTitle:   "Contract renewal",
			wantPriority: 3,
			wantDueDate: "2027-01-15",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseQuickAdd(tt.input, refTime)

			if got.Title != tt.wantTitle {
				t.Errorf("Title = %q, want %q", got.Title, tt.wantTitle)
			}
			if got.Priority != tt.wantPriority {
				t.Errorf("Priority = %d, want %d", got.Priority, tt.wantPriority)
			}
			if got.ProjectName != nil {
				t.Errorf("ProjectName = %v, want nil", got.ProjectName)
			}
			if tt.wantDueDate != "" && (got.DueDate == nil || *got.DueDate != tt.wantDueDate) {
				t.Errorf("DueDate = %v, want %q", got.DueDate, tt.wantDueDate)
			}
			if tt.wantRecurr != "" && (got.Recurrence == nil || *got.Recurrence != tt.wantRecurr) {
				t.Errorf("Recurrence = %v, want %q", got.Recurrence, tt.wantRecurr)
			}
			if tt.wantLocation != "" && (got.Location == nil || *got.Location != tt.wantLocation) {
				t.Errorf("Location = %v, want %q", got.Location, tt.wantLocation)
			}
		})
	}
}

func TestNextDueDate(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC) // Wednesday

	// Daily
	next := NextDueDate("2026-10-07", "daily", now)
	if next != "2026-10-08" {
		t.Errorf("Daily next = %q, want 2026-10-08", next)
	}

	// Weekly
	next = NextDueDate("2026-10-07", "weekly", now)
	if next != "2026-10-14" {
		t.Errorf("Weekly next = %q, want 2026-10-14", next)
	}

	// Weekdays
	next = NextDueDate("2026-10-09", "weekdays", now) // Friday -> Monday
	if next != "2026-10-12" {
		t.Errorf("Weekdays next = %q, want 2026-10-12", next)
	}

	// Cron (Every Monday at 09:00: 0 9 * * 1)
	next = NextDueDate("2026-10-07", "cron:0 9 * * 1", now) // Wednesday -> Next Monday (Oct 12)
	if next != "2026-10-12" {
		t.Errorf("Cron next = %q, want 2026-10-12", next)
	}

	// With time preserved
	next = NextDueDate("2026-10-07 14:30", "daily", now)
	if next != "2026-10-08 14:30" {
		t.Errorf("Daily with time next = %q, want 2026-10-08 14:30", next)
	}
}
