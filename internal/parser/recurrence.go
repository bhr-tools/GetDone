package parser

import (
	"strconv"
	"strings"
	"time"
)

// Recurrence rules:
//
//	daily | weekdays | weekly | monthly | yearly
//	weekly:<weekday>          e.g. weekly:monday
//	cron:<5 cron fields>      only day-of-month, month and day-of-week are used
var simpleRules = map[string]bool{
	"daily": true, "weekdays": true, "weekly": true, "monthly": true, "yearly": true,
}

var weekdayNames = map[string]time.Weekday{
	"sunday": time.Sunday, "monday": time.Monday, "tuesday": time.Tuesday,
	"wednesday": time.Wednesday, "thursday": time.Thursday, "friday": time.Friday,
	"saturday": time.Saturday,
}

// cronFieldRanges lists the allowed [min, max] of the five cron fields.
var cronFieldRanges = [5][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}

// ValidRecurrence reports whether rule is a supported recurrence rule.
func ValidRecurrence(rule string) bool {
	switch {
	case simpleRules[rule]:
		return true
	case strings.HasPrefix(rule, "weekly:"):
		_, ok := weekdayNames[strings.TrimPrefix(rule, "weekly:")]
		return ok
	case strings.HasPrefix(rule, "cron:"):
		fields := strings.Fields(strings.TrimPrefix(rule, "cron:"))
		if len(fields) != 5 {
			return false
		}
		for i, f := range fields {
			if !validCronField(f, cronFieldRanges[i][0], cronFieldRanges[i][1]) {
				return false
			}
		}
		return true
	}
	return false
}

// NormalizeRecurrence trims a rule and canonicalizes the spacing of cron rules.
func NormalizeRecurrence(rule string) string {
	rule = strings.TrimSpace(rule)
	if strings.HasPrefix(rule, "cron:") {
		return "cron:" + strings.Join(strings.Fields(strings.TrimPrefix(rule, "cron:")), " ")
	}
	return rule
}

func validCronField(field string, min, max int) bool {
	if field == "*" {
		return true
	}
	for _, part := range strings.Split(field, ",") {
		switch {
		case strings.HasPrefix(part, "*/"):
			step, err := strconv.Atoi(part[2:])
			if err != nil || step <= 0 {
				return false
			}
		case strings.Contains(part, "-"):
			lo, hi, found := strings.Cut(part, "-")
			a, errA := strconv.Atoi(lo)
			b, errB := strconv.Atoi(hi)
			if !found || errA != nil || errB != nil || a < min || b > max || a > b {
				return false
			}
		default:
			n, err := strconv.Atoi(part)
			if err != nil || n < min || n > max {
				return false
			}
		}
	}
	return true
}

// NextDueDate returns the next occurrence of a recurring task. The next date is
// computed from the later of the current due date and today, so completing an
// overdue task never schedules it in the past. The time of day is kept.
func NextDueDate(due, rule, today string) string {
	todayDay, _, _ := ParseDue(NormalizeToday(today))
	base := todayDay
	clock := ""
	if day, c, ok := ParseDue(due); ok {
		clock = c
		if day.After(base) {
			base = day
		}
	}

	var next time.Time
	switch {
	case rule == "daily":
		next = base.AddDate(0, 0, 1)
	case rule == "weekdays":
		next = base.AddDate(0, 0, 1)
		for next.Weekday() == time.Saturday || next.Weekday() == time.Sunday {
			next = next.AddDate(0, 0, 1)
		}
	case rule == "weekly":
		next = base.AddDate(0, 0, 7)
	case rule == "monthly":
		next = addMonthsClamped(base, 1)
	case rule == "yearly":
		next = addMonthsClamped(base, 12)
	case strings.HasPrefix(rule, "weekly:"):
		next = NextWeekday(base, weekdayNames[strings.TrimPrefix(rule, "weekly:")])
	case strings.HasPrefix(rule, "cron:"):
		next = nextCronDate(base, strings.Fields(strings.TrimPrefix(rule, "cron:")))
	default:
		next = base.AddDate(0, 0, 1)
	}
	return FormatDue(next, clock)
}

// NextWeekday returns the first day strictly after from that falls on wd.
func NextWeekday(from time.Time, wd time.Weekday) time.Time {
	days := int(wd - from.Weekday())
	if days <= 0 {
		days += 7
	}
	return from.AddDate(0, 0, days)
}

// addMonthsClamped adds months without overflowing into the following month:
// January 31 + 1 month is February 28 (or 29), not March 3.
func addMonthsClamped(t time.Time, months int) time.Time {
	first := time.Date(t.Year(), t.Month()+time.Month(months), 1, 0, 0, 0, 0, time.UTC)
	lastDay := first.AddDate(0, 1, -1).Day()
	day := t.Day()
	if day > lastDay {
		day = lastDay
	}
	return time.Date(first.Year(), first.Month(), day, 0, 0, 0, 0, time.UTC)
}

// nextCronDate finds the first day after base matching the day-of-month, month
// and day-of-week fields. As in standard cron, when both day-of-month and
// day-of-week are restricted, a day matching either one is accepted.
func nextCronDate(base time.Time, fields []string) time.Time {
	if len(fields) != 5 {
		return base.AddDate(0, 0, 1)
	}
	domF, monthF, dowF := fields[2], fields[3], fields[4]
	cur := base.AddDate(0, 0, 1)
	for i := 0; i < 366*5; i++ {
		dow := int(cur.Weekday())
		domOK := matchCronField(cur.Day(), domF)
		dowOK := matchCronField(dow, dowF) || (dow == 0 && matchCronField(7, dowF))
		dayOK := domOK && dowOK
		if domF != "*" && dowF != "*" {
			dayOK = domOK || dowOK
		}
		if dayOK && matchCronField(int(cur.Month()), monthF) {
			return cur
		}
		cur = cur.AddDate(0, 0, 1)
	}
	return base.AddDate(0, 0, 1)
}

func matchCronField(val int, field string) bool {
	if field == "*" {
		return true
	}
	for _, part := range strings.Split(field, ",") {
		switch {
		case strings.HasPrefix(part, "*/"):
			if step, err := strconv.Atoi(part[2:]); err == nil && step > 0 && val%step == 0 {
				return true
			}
		case strings.Contains(part, "-"):
			lo, hi, _ := strings.Cut(part, "-")
			a, errA := strconv.Atoi(lo)
			b, errB := strconv.Atoi(hi)
			if errA == nil && errB == nil && val >= a && val <= b {
				return true
			}
		default:
			if n, err := strconv.Atoi(part); err == nil && n == val {
				return true
			}
		}
	}
	return false
}
