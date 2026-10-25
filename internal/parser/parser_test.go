package parser

import "testing"

// Reference day for all tests: Wednesday 7 October 2026.
const today = "2026-10-07"

func TestValidDue(t *testing.T) {
	valid := []string{"2026-10-07", "2026-10-07 09:30", "2028-02-29"}
	invalid := []string{"", "2026-10-7", "2026-13-01", "2026-02-30", "2026-10-07 9:30", "2026-10-07 25:00", "2027-02-29", "tomorrow"}
	for _, s := range valid {
		if !ValidDue(s) {
			t.Errorf("ValidDue(%q) = false, want true", s)
		}
	}
	for _, s := range invalid {
		if ValidDue(s) {
			t.Errorf("ValidDue(%q) = true, want false", s)
		}
	}
}

func TestShiftDueAndDaysBetween(t *testing.T) {
	if got, _ := ShiftDue("2026-10-30 14:00", 3); got != "2026-11-02 14:00" {
		t.Errorf("ShiftDue = %q", got)
	}
	if got, _ := DaysBetween("2026-10-07 23:00", "2026-10-10"); got != 3 {
		t.Errorf("DaysBetween = %d, want 3", got)
	}
	if _, ok := ShiftDue("garbage", 1); ok {
		t.Error("ShiftDue accepted garbage")
	}
}

func TestValidRecurrence(t *testing.T) {
	valid := []string{"daily", "weekdays", "weekly", "monthly", "yearly", "weekly:monday", "cron:0 9 * * 1", "cron:*/5 * 1,15 * 1-5"}
	invalid := []string{"", "every day", "weekly:funday", "cron:0 9 * *", "cron:0 9 32 * *", "cron:a b c d e", "cron:0 9 * * 5-1"}
	for _, s := range valid {
		if !ValidRecurrence(s) {
			t.Errorf("ValidRecurrence(%q) = false, want true", s)
		}
	}
	for _, s := range invalid {
		if ValidRecurrence(s) {
			t.Errorf("ValidRecurrence(%q) = true, want false", s)
		}
	}
	if got := NormalizeRecurrence("  cron:0   9 * *  1 "); got != "cron:0 9 * * 1" {
		t.Errorf("NormalizeRecurrence = %q", got)
	}
}

func TestNextDueDate(t *testing.T) {
	tests := []struct {
		due, rule, want string
	}{
		{"2026-10-07", "daily", "2026-10-08"},
		{"2026-10-07 14:30", "daily", "2026-10-08 14:30"},
		{"2026-10-07", "weekly", "2026-10-14"},
		{"2026-10-09", "weekdays", "2026-10-12"}, // Friday -> Monday
		{"2026-10-07", "weekly:monday", "2026-10-12"},
		{"2026-10-07", "cron:0 9 * * 1", "2026-10-12"},
		{"2026-10-07", "cron:0 9 1,15 * 5", "2026-10-09"}, // dom OR dow: Friday 9th comes first
		{"2026-01-31", "monthly", "2026-11-07"},           // overdue: counted from today
		{"2026-10-31", "monthly", "2026-11-30"},           // clamped to the end of November
		{"2028-02-29", "yearly", "2029-02-28"},
		{"2026-09-01", "daily", "2026-10-08"}, // overdue: next occurrence after today
		{"", "daily", "2026-10-08"},           // no due date: from today
	}
	for _, tt := range tests {
		if got := NextDueDate(tt.due, tt.rule, today); got != tt.want {
			t.Errorf("NextDueDate(%q, %q) = %q, want %q", tt.due, tt.rule, got, tt.want)
		}
	}
}

func TestExtractDueDate(t *testing.T) {
	tests := []struct {
		in, wantDue, wantRest string
	}{
		{"demain 14h30", "2026-10-08 14:30", ""},
		{"tomorrow 14:00", "2026-10-08 14:00", ""},
		{"october 23", "2026-10-23", ""},
		{"23 october", "2026-10-23", ""},
		{"23 oct 18:00", "2026-10-23 18:00", ""},
		{"23 octobre", "2026-10-23", ""},
		{"octobre 23", "2026-10-23", ""},
		{"12 nov", "2026-11-12", ""},
		{"15 décembre", "2026-12-15", ""},
		{"5 oct", "2027-10-05", ""}, // already past this year
		{"15 janvier", "2027-01-15", ""},
		{"fri", "2026-10-09", ""},
		{"this weekend", "2026-10-10", ""},
		{"2026-10-05", "2026-10-05", ""}, // ISO wins over DD-MM
		{"2026-10-05 08:15", "2026-10-05 08:15", ""},
		{"15/10", "2026-10-15", ""},
		{"31/02", "", "31/02"},
		{"18h", "2026-10-07 18:00", ""},
		{"Oct 23, 2027", "2027-10-23", ""},
		{"mon rendez-vous", "", "mon rendez-vous"}, // French "mon" is not Monday
		{"nothing here", "", "nothing here"},
	}
	for _, tt := range tests {
		due, rest := ExtractDueDate(tt.in, today)
		if due != tt.wantDue {
			t.Errorf("ExtractDueDate(%q) due = %q, want %q", tt.in, due, tt.wantDue)
		}
		if tt.wantRest != "" && rest != tt.wantRest {
			t.Errorf("ExtractDueDate(%q) rest = %q, want %q", tt.in, rest, tt.wantRest)
		}
	}
}

func TestExtractRecurrence(t *testing.T) {
	tests := []struct{ in, want string }{
		{"every day", "daily"},
		{"tous les lundis 09:00", "weekly:monday"},
		{"every weekday", "weekdays"},
		{"chaque année", "yearly"},
		{"cron:0 9 * * 1", "cron:0 9 * * 1"},
		{"cron:bad", ""},
		{"Oct 23", ""},
	}
	for _, tt := range tests {
		if got, _ := ExtractRecurrence(tt.in); got != tt.want {
			t.Errorf("ExtractRecurrence(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
