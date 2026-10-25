package parser

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Natural-language extraction (English and French), used to read the DATE
// column of Todoist CSV files. The interactive quick add is parsed in the
// browser (web/js/quickadd.js) with the same vocabulary.

const monthPattern = `january|janvier|janv|jan|february|f[eé]vrier|f[eé]vr|f[eé]v|feb|march|mars|mar|april|avril|avr|apr|may|mai|june|juin|jun|july|juillet|juil|jul|august|ao[uû]t|aug|september|septembre|sept|sep|october|octobre|oct|november|novembre|nov|december|d[eé]cembre|d[eé]c|dec`

var (
	isoDateRegex      = regexp.MustCompile(`\b(\d{4})-(\d{2})-(\d{2})\b`)
	numericDateRegex  = regexp.MustCompile(`\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b`)
	dayMonthRegex     = regexp.MustCompile(`(?i)\b(\d{1,2})(?:st|nd|rd|th|er)?\s+(` + monthPattern + `)\.?(?:\s+(\d{4}))?\b`)
	monthDayRegex     = regexp.MustCompile(`(?i)\b(` + monthPattern + `)\.?\s+(\d{1,2})(?:st|nd|rd|th|er)?(?:,?\s+(\d{4}))?\b`)
	timeRegex         = regexp.MustCompile(`(?i)\b(\d{1,2})(?:(?::(\d{2}))?\s*(am|pm)|h(\d{2})?|:(\d{2}))\b`)
	cronRuleRegex     = regexp.MustCompile(`(?i)\bcron:(\S+(?:\s+\S+){4})`)
	relativeDayRegexs = []struct {
		re     *regexp.Regexp
		offset int
	}{
		{regexp.MustCompile(`(?i)\b(?:après-demain|apres-demain|day after tomorrow)\b`), 2},
		{regexp.MustCompile(`(?i)\b(?:aujourd'hui|aujourdhui|today|ajd)\b`), 0},
		{regexp.MustCompile(`(?i)\b(?:demain|tomorrow)\b`), 1},
		{regexp.MustCompile(`(?i)\b(?:hier|yesterday)\b`), -1},
	}
	weekdayRegexs = []struct {
		re *regexp.Regexp
		wd time.Weekday
	}{
		{regexp.MustCompile(`(?i)\b(?:ce week-end|ce weekend|this weekend|weekend)\b`), time.Saturday},
		{regexp.MustCompile(`(?i)\b(?:lundi|monday)\b`), time.Monday},
		{regexp.MustCompile(`(?i)\b(?:mardi|tuesday|tue)\b`), time.Tuesday},
		{regexp.MustCompile(`(?i)\b(?:mercredi|wednesday|wed)\b`), time.Wednesday},
		{regexp.MustCompile(`(?i)\b(?:jeudi|thursday|thu)\b`), time.Thursday},
		{regexp.MustCompile(`(?i)\b(?:vendredi|friday|fri)\b`), time.Friday},
		{regexp.MustCompile(`(?i)\b(?:samedi|saturday|sat)\b`), time.Saturday},
		{regexp.MustCompile(`(?i)\b(?:dimanche|sunday|sun)\b`), time.Sunday},
	}
	recurrencePatterns = []struct {
		re   *regexp.Regexp
		rule string
	}{
		{regexp.MustCompile(`(?i)\b(?:tous les jours ouvrés|jours ouvrés|every weekday|weekdays)\b`), "weekdays"},
		{regexp.MustCompile(`(?i)\b(?:tous les jours|chaque jour|every day|daily)\b`), "daily"},
		{regexp.MustCompile(`(?i)\b(?:toutes les semaines|chaque semaine|every week|weekly)\b`), "weekly"},
		{regexp.MustCompile(`(?i)\b(?:tous les mois|chaque mois|every month|monthly)\b`), "monthly"},
		{regexp.MustCompile(`(?i)\b(?:tous les ans|chaque année|chaque annee|every year|yearly)\b`), "yearly"},
		{regexp.MustCompile(`(?i)\b(?:tous les lundis|chaque lundi|every monday)\b`), "weekly:monday"},
		{regexp.MustCompile(`(?i)\b(?:tous les mardis|chaque mardi|every tuesday)\b`), "weekly:tuesday"},
		{regexp.MustCompile(`(?i)\b(?:tous les mercredis|chaque mercredi|every wednesday)\b`), "weekly:wednesday"},
		{regexp.MustCompile(`(?i)\b(?:tous les jeudis|chaque jeudi|every thursday)\b`), "weekly:thursday"},
		{regexp.MustCompile(`(?i)\b(?:tous les vendredis|chaque vendredi|every friday)\b`), "weekly:friday"},
		{regexp.MustCompile(`(?i)\b(?:tous les samedis|chaque samedi|every saturday)\b`), "weekly:saturday"},
		{regexp.MustCompile(`(?i)\b(?:tous les dimanches|chaque dimanche|every sunday)\b`), "weekly:sunday"},
	}
)

var monthNumbers = map[string]int{
	"january": 1, "janvier": 1, "janv": 1, "jan": 1,
	"february": 2, "fevrier": 2, "fevr": 2, "fev": 2, "feb": 2,
	"march": 3, "mars": 3, "mar": 3,
	"april": 4, "avril": 4, "avr": 4, "apr": 4,
	"may": 5, "mai": 5,
	"june": 6, "juin": 6, "jun": 6,
	"july": 7, "juillet": 7, "juil": 7, "jul": 7,
	"august": 8, "aout": 8, "aug": 8,
	"september": 9, "septembre": 9, "sept": 9, "sep": 9,
	"october": 10, "octobre": 10, "oct": 10,
	"november": 11, "novembre": 11, "nov": 11,
	"december": 12, "decembre": 12, "dec": 12,
}

func monthNumber(name string) int {
	clean := strings.ToLower(strings.TrimSpace(name))
	clean = strings.NewReplacer("é", "e", "û", "u").Replace(clean)
	return monthNumbers[clean]
}

// ExtractRecurrence finds a recurrence expression in s and returns the rule
// and s without it. rule is empty when none is found.
func ExtractRecurrence(s string) (rule, rest string) {
	if m := cronRuleRegex.FindStringSubmatch(s); m != nil {
		candidate := NormalizeRecurrence("cron:" + m[1])
		if ValidRecurrence(candidate) {
			return candidate, cronRuleRegex.ReplaceAllString(s, " ")
		}
	}
	for _, p := range recurrencePatterns {
		if p.re.MatchString(s) {
			return p.rule, p.re.ReplaceAllString(s, " ")
		}
	}
	return "", s
}

// ExtractDueDate finds a date (and optional time) in s, relative to today
// ("YYYY-MM-DD"), and returns it as a due string along with s without it.
// due is empty when no date or time is found.
func ExtractDueDate(s, today string) (due, rest string) {
	todayDay, _, _ := ParseDue(NormalizeToday(today))
	rest = s

	clock := ""
	if m := timeRegex.FindStringSubmatch(rest); m != nil {
		if c, ok := parseClock(m); ok {
			clock = c
			rest = strings.Replace(rest, m[0], " ", 1)
		}
	}

	day, found := time.Time{}, false
	if m := isoDateRegex.FindStringSubmatch(rest); m != nil {
		if d, ok := makeDate(m[1], m[2], m[3]); ok {
			day, found = d, true
			rest = strings.Replace(rest, m[0], " ", 1)
		}
	}
	if !found {
		if m := dayMonthRegex.FindStringSubmatch(rest); m != nil {
			day, found = calendarDate(m[1], monthNumber(m[2]), m[3], todayDay)
			if found {
				rest = strings.Replace(rest, m[0], " ", 1)
			}
		}
	}
	if !found {
		if m := monthDayRegex.FindStringSubmatch(rest); m != nil {
			day, found = calendarDate(m[2], monthNumber(m[1]), m[3], todayDay)
			if found {
				rest = strings.Replace(rest, m[0], " ", 1)
			}
		}
	}
	if !found {
		if m := numericDateRegex.FindStringSubmatch(rest); m != nil {
			month, _ := strconv.Atoi(m[2])
			day, found = calendarDate(m[1], month, m[3], todayDay)
			if found {
				rest = strings.Replace(rest, m[0], " ", 1)
			}
		}
	}
	if !found {
		for _, kw := range relativeDayRegexs {
			if loc := kw.re.FindStringIndex(rest); loc != nil {
				day, found = todayDay.AddDate(0, 0, kw.offset), true
				rest = rest[:loc[0]] + " " + rest[loc[1]:]
				break
			}
		}
	}
	if !found {
		for _, kw := range weekdayRegexs {
			if loc := kw.re.FindStringIndex(rest); loc != nil {
				day, found = NextWeekday(todayDay, kw.wd), true
				rest = rest[:loc[0]] + " " + rest[loc[1]:]
				break
			}
		}
	}

	if !found && clock == "" {
		return "", s
	}
	if !found {
		day = todayDay
	}
	return FormatDue(day, clock), rest
}

// parseClock converts a timeRegex match into "HH:MM".
func parseClock(m []string) (string, bool) {
	hour, _ := strconv.Atoi(m[1])
	minute := 0
	for _, g := range []string{m[2], m[4], m[5]} {
		if g != "" {
			minute, _ = strconv.Atoi(g)
		}
	}
	switch strings.ToLower(m[3]) {
	case "pm":
		if hour < 12 {
			hour += 12
		}
	case "am":
		if hour == 12 {
			hour = 0
		}
	}
	if hour > 23 || minute > 59 {
		return "", false
	}
	return fmt.Sprintf("%02d:%02d", hour, minute), true
}

func makeDate(y, m, d string) (time.Time, bool) {
	year, _ := strconv.Atoi(y)
	month, _ := strconv.Atoi(m)
	day, _ := strconv.Atoi(d)
	return validDate(year, month, day)
}

func validDate(year, month, day int) (time.Time, bool) {
	if month < 1 || month > 12 || day < 1 {
		return time.Time{}, false
	}
	t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if t.Day() != day {
		return time.Time{}, false // e.g. 31 February
	}
	return t, true
}

// calendarDate builds a date from a day, a month and an optional year. Without
// a year, a date already past this year is moved to next year.
func calendarDate(dayStr string, month int, yearStr string, today time.Time) (time.Time, bool) {
	day, _ := strconv.Atoi(dayStr)
	year := today.Year()
	if yearStr != "" {
		year, _ = strconv.Atoi(yearStr)
		if year < 100 {
			year += 2000
		}
	}
	t, ok := validDate(year, month, day)
	if !ok {
		return time.Time{}, false
	}
	if yearStr == "" && t.Before(today) {
		if next, ok := validDate(year+1, month, day); ok {
			t = next
		}
	}
	return t, true
}
