// Package parser holds the date and recurrence rules shared by the store and
// the CSV importer. Due dates are plain strings, "YYYY-MM-DD" or
// "YYYY-MM-DD HH:MM", always interpreted in the user's local time.
package parser

import (
	"regexp"
	"strings"
	"time"
)

const (
	DateLayout     = "2006-01-02"
	DateTimeLayout = "2006-01-02 15:04"
)

var dueRegex = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$`)

// ParseDue splits a due string into its calendar day and optional "HH:MM" time.
// ok is false when the string is not a valid due date.
func ParseDue(due string) (day time.Time, clock string, ok bool) {
	if !dueRegex.MatchString(due) {
		return time.Time{}, "", false
	}
	if len(due) == len(DateLayout) {
		d, err := time.Parse(DateLayout, due)
		return d, "", err == nil
	}
	dt, err := time.Parse(DateTimeLayout, due)
	if err != nil {
		return time.Time{}, "", false
	}
	return time.Date(dt.Year(), dt.Month(), dt.Day(), 0, 0, 0, 0, time.UTC), due[len(DateLayout)+1:], true
}

// ValidDue reports whether due is a well-formed due date.
func ValidDue(due string) bool {
	_, _, ok := ParseDue(due)
	return ok
}

// FormatDue joins a calendar day and an optional "HH:MM" time.
func FormatDue(day time.Time, clock string) string {
	s := day.Format(DateLayout)
	if clock != "" {
		s += " " + clock
	}
	return s
}

// ShiftDue moves a due date by a number of days, keeping its time.
func ShiftDue(due string, days int) (string, bool) {
	day, clock, ok := ParseDue(due)
	if !ok {
		return "", false
	}
	return FormatDue(day.AddDate(0, 0, days), clock), true
}

// DaysBetween returns the number of calendar days from a to b (b - a).
func DaysBetween(a, b string) (int, bool) {
	da, _, okA := ParseDue(a)
	db, _, okB := ParseDue(b)
	if !okA || !okB {
		return 0, false
	}
	return int(db.Sub(da).Hours() / 24), true
}

// Today returns the current calendar day in the server's local time zone.
func Today() string {
	return time.Now().Format(DateLayout)
}

// NormalizeToday returns s when it is a valid "YYYY-MM-DD" day, otherwise the
// server's local today. Clients send their own today so that "overdue" and
// "next occurrence" follow the user's time zone rather than the server's.
func NormalizeToday(s string) string {
	s = strings.TrimSpace(s)
	if len(s) == len(DateLayout) && ValidDue(s) {
		return s
	}
	return Today()
}
