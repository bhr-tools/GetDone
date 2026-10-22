package parser

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ben/get-done/internal/db"
)

var (
	priorityRegex     = regexp.MustCompile(`(?i)(?:^|\s)(?:p|!)([1-3])(?:\s|$)`)
	locationWordRegex = regexp.MustCompile(`(?i)@([a-zA-Z0-9_\-'.]+(?:\s+[a-zA-Z0-9_\-'.]+)*)`)
	explicitDateRegex = regexp.MustCompile(`\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b`)
	isoDateRegex      = regexp.MustCompile(`\b(\d{4})-(\d{2})-(\d{2})\b`)
	timeRegex         = regexp.MustCompile(`(?i)\b(\d{1,2})(?:(?::(\d{2}))?\s*(am|pm)|h(\d{2})?|:(\d{2}))\b`)

	monthNamesPattern = `(?i)(?:january|janvier|janv|jan|february|f[eé]vrier|f[eé]vr|f[eé]v|feb|march|mars|mar|april|avril|avr|apr|may|mai|june|juin|jui|jun|july|juillet|juil|jul|august|ao[uû]t|ao[uû]|aug|september|septembre|sept|sep|october|octobre|oct|november|novembre|nov|december|d[eé]cembre|d[eé]c|dec)`
	dayMonthRegex     = regexp.MustCompile(`\b(\d{1,2})(?:st|nd|rd|th|er)?\s+(` + monthNamesPattern + `)(?:\s+(\d{2,4}))?\b`)
	monthDayRegex     = regexp.MustCompile(`\b(` + monthNamesPattern + `)\s+(\d{1,2})(?:st|nd|rd|th|er)?(?:\s+(\d{2,4}))?\b`)
)

// ParseQuickAdd parses an input string deterministically without external services.
func ParseQuickAdd(input string, now time.Time) db.QuickAddParsed {
	result := db.QuickAddParsed{
		Priority: 3, // default neutral priority (P3)
	}

	work := input

	// 1. Extract Priority (p1..p4 or !1..!4)
	if match := priorityRegex.FindStringSubmatch(work); len(match) > 1 {
		p, _ := strconv.Atoi(match[1])
		result.Priority = p
		work = priorityRegex.ReplaceAllString(work, " ")
	}

	// 2. Extract Recurrence
	recurrence, cleanedAfterRecurrence := extractRecurrence(work)
	if recurrence != "" {
		result.Recurrence = &recurrence
		work = cleanedAfterRecurrence
	}

	// 4. Extract Date & Time
	dueDate, cleanedAfterDate := extractDueDate(work, now)
	if dueDate != "" {
		result.DueDate = &dueDate
		work = cleanedAfterDate
	}

	// Align weekly weekday recurrence with next occurrence of that weekday
	if result.Recurrence != nil && strings.HasPrefix(*result.Recurrence, "weekly:") {
		targetWd := parseWeekdayName(strings.TrimPrefix(*result.Recurrence, "weekly:"))
		nextDate := nextWeekday(now, targetWd)
		datePart := nextDate.Format("2006-01-02")
		if result.DueDate != nil && strings.Contains(*result.DueDate, " ") {
			parts := strings.SplitN(*result.DueDate, " ", 2)
			combined := datePart + " " + parts[1]
			result.DueDate = &combined
		} else if result.DueDate == nil {
			result.DueDate = &datePart
		}
	}

	// 5. Extract Location (@...)
	location, cleanedAfterLoc := extractLocation(work)
	if location != "" {
		result.Location = &location
		work = cleanedAfterLoc
	}

	// Clean up title
	title := strings.Join(strings.Fields(work), " ")
	result.Title = title

	return result
}

func extractRecurrence(s string) (string, string) {
	// 1. Explicit cron expression: cron:... or cron "..."
	cronRegex := regexp.MustCompile(`(?i)\bcron:([^\s]+(?:\s+[^\s]+){4})\b`)
	if match := cronRegex.FindStringSubmatch(s); len(match) > 1 {
		cleaned := cronRegex.ReplaceAllString(s, " ")
		return "cron:" + strings.TrimSpace(match[1]), cleaned
	}

	lower := strings.ToLower(s)

	patterns := []struct {
		pattern string
		rule    string
	}{
		{`\b(?:tous les jours ouvrés|jours ouvrés|every weekday|weekdays)\b`, "weekdays"},
		{`\b(?:tous les jours|chaque jour|every day|daily)\b`, "daily"},
		{`\b(?:toutes les semaines|chaque semaine|every week|weekly)\b`, "weekly"},
		{`\b(?:tous les mois|chaque mois|every month|monthly)\b`, "monthly"},
		{`\b(?:tous les ans|chaque annee|every year|yearly)\b`, "yearly"},
		{`\b(?:tous les lundis|chaque lundi|every monday)\b`, "weekly:monday"},
		{`\b(?:tous les mardis|chaque mardi|every tuesday)\b`, "weekly:tuesday"},
		{`\b(?:tous les mercredis|chaque mercredi|every wednesday)\b`, "weekly:wednesday"},
		{`\b(?:tous les jeudis|chaque jeudi|every thursday)\b`, "weekly:thursday"},
		{`\b(?:tous les vendredis|chaque vendredi|every friday)\b`, "weekly:friday"},
		{`\b(?:tous les samedis|chaque samedi|every saturday)\b`, "weekly:saturday"},
		{`\b(?:tous les dimanches|chaque dimanche|every sunday)\b`, "weekly:sunday"},
	}

	for _, p := range patterns {
		re := regexp.MustCompile("(?i)" + p.pattern)
		if re.MatchString(lower) {
			cleaned := re.ReplaceAllString(s, " ")
			return p.rule, cleaned
		}
	}

	return "", s
}

func extractDueDate(s string, now time.Time) (string, string) {
	var targetDate *time.Time
	cleaned := s

	// Check time first
	timeStr := ""
	if match := timeRegex.FindStringSubmatch(s); len(match) > 1 {
		hour, _ := strconv.Atoi(match[1])
		minute := 0
		ampm := ""
		if len(match) > 3 && match[3] != "" {
			ampm = strings.ToLower(match[3])
		}
		if len(match) > 2 && match[2] != "" {
			minute, _ = strconv.Atoi(match[2])
		} else if len(match) > 4 && match[4] != "" {
			minute, _ = strconv.Atoi(match[4])
		} else if len(match) > 5 && match[5] != "" {
			minute, _ = strconv.Atoi(match[5])
		}
		if ampm == "pm" && hour < 12 {
			hour += 12
		} else if ampm == "am" && hour == 12 {
			hour = 0
		}
		if hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 {
			timeStr = fmt.Sprintf(" %02d:%02d", hour, minute)
			cleaned = timeRegex.ReplaceAllString(cleaned, " ")
		}
	}

	// Keywords
	keywords := []struct {
		pattern string
		offset  int
		weekday *time.Weekday
	}{
		{`(?i)\b(?:aujourd'hui|aujourdhui|today|ajd)\b`, 0, nil},
		{`(?i)\b(?:demain|tomorrow)\b`, 1, nil},
		{`(?i)\b(?:après-demain|apres-demain|day after tomorrow)\b`, 2, nil},
		{`(?i)\b(?:ce week-end|ce weekend|this weekend|weekend)\b`, 0, ptrWeekday(time.Saturday)},
		{`(?i)\b(?:hier|yesterday)\b`, -1, nil},
		{`(?i)\b(?:lundi|monday|mon)\b`, 0, ptrWeekday(time.Monday)},
		{`(?i)\b(?:mardi|tuesday|tue)\b`, 0, ptrWeekday(time.Tuesday)},
		{`(?i)\b(?:mercredi|wednesday|wed)\b`, 0, ptrWeekday(time.Wednesday)},
		{`(?i)\b(?:jeudi|thursday|thu)\b`, 0, ptrWeekday(time.Thursday)},
		{`(?i)\b(?:vendredi|friday|fri)\b`, 0, ptrWeekday(time.Friday)},
		{`(?i)\b(?:samedi|saturday|sat)\b`, 0, ptrWeekday(time.Saturday)},
		{`(?i)\b(?:dimanche|sunday|sun)\b`, 0, ptrWeekday(time.Sunday)},
	}

	for _, kw := range keywords {
		re := regexp.MustCompile(kw.pattern)
		if re.MatchString(cleaned) {
			if kw.weekday != nil {
				d := nextWeekday(now, *kw.weekday)
				targetDate = &d
			} else {
				d := now.AddDate(0, 0, kw.offset)
				targetDate = &d
			}
			cleaned = re.ReplaceAllString(cleaned, " ")
			break
		}
	}

	// Month Day or Day Month natural expressions (e.g., 23 october, october 23, 12 nov, 15 décembre)
	if targetDate == nil {
		if match := dayMonthRegex.FindStringSubmatch(cleaned); len(match) > 2 {
			day, _ := strconv.Atoi(match[1])
			month := parseMonth(match[2])
			if month >= 1 && month <= 12 && day >= 1 && day <= 31 {
				year := now.Year()
				hasExplicitYear := false
				if len(match) > 3 && match[3] != "" {
					y, _ := strconv.Atoi(match[3])
					if y < 100 {
						year = 2000 + y
					} else {
						year = y
					}
					hasExplicitYear = true
				}
				d := time.Date(year, time.Month(month), day, 0, 0, 0, 0, now.Location())
				if !hasExplicitYear {
					todayDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
					if d.Before(todayDate) {
						d = d.AddDate(1, 0, 0)
					}
				}
				targetDate = &d
				cleaned = dayMonthRegex.ReplaceAllString(cleaned, " ")
			}
		}
	}

	if targetDate == nil {
		if match := monthDayRegex.FindStringSubmatch(cleaned); len(match) > 2 {
			month := parseMonth(match[1])
			day, _ := strconv.Atoi(match[2])
			if month >= 1 && month <= 12 && day >= 1 && day <= 31 {
				year := now.Year()
				hasExplicitYear := false
				if len(match) > 3 && match[3] != "" {
					y, _ := strconv.Atoi(match[3])
					if y < 100 {
						year = 2000 + y
					} else {
						year = y
					}
					hasExplicitYear = true
				}
				d := time.Date(year, time.Month(month), day, 0, 0, 0, 0, now.Location())
				if !hasExplicitYear {
					todayDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
					if d.Before(todayDate) {
						d = d.AddDate(1, 0, 0)
					}
				}
				targetDate = &d
				cleaned = monthDayRegex.ReplaceAllString(cleaned, " ")
			}
		}
	}

	// Explicit date DD/MM or DD/MM/YYYY
	if targetDate == nil {
		if match := explicitDateRegex.FindStringSubmatch(cleaned); len(match) > 2 {
			day, _ := strconv.Atoi(match[1])
			month, _ := strconv.Atoi(match[2])
			year := now.Year()
			if len(match) > 3 && match[3] != "" {
				y, _ := strconv.Atoi(match[3])
				if y < 100 {
					year = 2000 + y
				} else {
					year = y
				}
			}
			if month >= 1 && month <= 12 && day >= 1 && day <= 31 {
				d := time.Date(year, time.Month(month), day, 0, 0, 0, 0, now.Location())
				// If date in DD/MM is already passed this year and no year specified, assume next year
				if len(match) <= 3 || match[3] == "" {
					todayDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
					if d.Before(todayDate) {
						d = d.AddDate(1, 0, 0)
					}
				}
				targetDate = &d
				cleaned = explicitDateRegex.ReplaceAllString(cleaned, " ")
			}
		}
	}

	// ISO date YYYY-MM-DD
	if targetDate == nil {
		if match := isoDateRegex.FindStringSubmatch(cleaned); len(match) > 3 {
			year, _ := strconv.Atoi(match[1])
			month, _ := strconv.Atoi(match[2])
			day, _ := strconv.Atoi(match[3])
			d := time.Date(year, time.Month(month), day, 0, 0, 0, 0, now.Location())
			targetDate = &d
			cleaned = isoDateRegex.ReplaceAllString(cleaned, " ")
		}
	}

	if targetDate != nil {
		datePart := targetDate.Format("2006-01-02")
		return datePart + timeStr, cleaned
	}

	if timeStr != "" {
		// Time specified without date implies today
		return now.Format("2006-01-02") + timeStr, cleaned
	}

	return "", s
}

func ptrWeekday(w time.Weekday) *time.Weekday {
	return &w
}

func nextWeekday(current time.Time, target time.Weekday) time.Time {
	days := int(target - current.Weekday())
	if days <= 0 {
		days += 7
	}
	return current.AddDate(0, 0, days)
}

// NextDueDate calculates the next occurrence for a recurring task.
func NextDueDate(currentDateStr string, recurrence string, now time.Time) string {
	if recurrence == "" {
		return ""
	}

	// Parse current date
	var parsedDate time.Time
	hasTime := false
	timePart := ""

	if strings.Contains(currentDateStr, " ") {
		parts := strings.SplitN(currentDateStr, " ", 2)
		if t, err := time.Parse("2006-01-02", parts[0]); err == nil {
			parsedDate = t
			hasTime = true
			timePart = " " + parts[1]
		}
	} else {
		if t, err := time.Parse("2006-01-02", currentDateStr); err == nil {
			parsedDate = t
		}
	}

	if parsedDate.IsZero() {
		parsedDate = now
	}

	todayZero := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	base := parsedDate
	if base.Before(todayZero) {
		base = todayZero
	}

	var next time.Time

	switch {
	case recurrence == "daily":
		next = base.AddDate(0, 0, 1)
	case recurrence == "weekly":
		next = base.AddDate(0, 0, 7)
	case recurrence == "weekdays":
		next = base.AddDate(0, 0, 1)
		for next.Weekday() == time.Saturday || next.Weekday() == time.Sunday {
			next = next.AddDate(0, 0, 1)
		}
	case recurrence == "monthly":
		next = base.AddDate(0, 1, 0)
	case recurrence == "yearly":
		next = base.AddDate(1, 0, 0)
	case strings.HasPrefix(recurrence, "weekly:"):
		weekdayName := strings.TrimPrefix(recurrence, "weekly:")
		targetWd := parseWeekdayName(weekdayName)
		next = nextWeekday(base, targetWd)
	case strings.HasPrefix(recurrence, "cron:") || len(strings.Fields(recurrence)) == 5:
		cronExpr := strings.TrimPrefix(recurrence, "cron:")
		next = nextCronDate(base, cronExpr)
	default:
		next = base.AddDate(0, 0, 1)
	}

	res := next.Format("2006-01-02")
	if hasTime {
		res += timePart
	}
	return res
}

func matchCronField(val int, field string) bool {
	if field == "*" {
		return true
	}
	parts := strings.Split(field, ",")
	for _, part := range parts {
		if strings.HasPrefix(part, "*/") {
			step, err := strconv.Atoi(part[2:])
			if err == nil && step > 0 && val%step == 0 {
				return true
			}
		} else if strings.Contains(part, "-") {
			rangeParts := strings.SplitN(part, "-", 2)
			low, err1 := strconv.Atoi(rangeParts[0])
			high, err2 := strconv.Atoi(rangeParts[1])
			if err1 == nil && err2 == nil && val >= low && val <= high {
				return true
			}
		} else {
			num, err := strconv.Atoi(part)
			if err == nil && num == val {
				return true
			}
		}
	}
	return false
}

func nextCronDate(base time.Time, expr string) time.Time {
	fields := strings.Fields(strings.TrimSpace(expr))
	if len(fields) != 5 {
		return base.AddDate(0, 0, 1)
	}
	_, _, domF, monthF, dowF := fields[0], fields[1], fields[2], fields[3], fields[4]

	cur := base.AddDate(0, 0, 1)
	cur = time.Date(cur.Year(), cur.Month(), cur.Day(), 0, 0, 0, 0, base.Location())

	for i := 0; i < 366*2; i++ {
		month := int(cur.Month())
		dom := cur.Day()
		dow := int(cur.Weekday())

		if matchCronField(month, monthF) && matchCronField(dom, domF) && (matchCronField(dow, dowF) || (dow == 0 && matchCronField(7, dowF))) {
			return cur
		}
		cur = cur.AddDate(0, 0, 1)
	}
	return base.AddDate(0, 0, 1)
}

func parseWeekdayName(name string) time.Weekday {
	switch strings.ToLower(name) {
	case "sunday", "dimanche", "sun":
		return time.Sunday
	case "monday", "lundi", "mon":
		return time.Monday
	case "tuesday", "mardi", "tue":
		return time.Tuesday
	case "wednesday", "mercredi", "wed":
		return time.Wednesday
	case "thursday", "jeudi", "thu":
		return time.Thursday
	case "friday", "vendredi", "fri":
		return time.Friday
	case "saturday", "samedi", "sat":
		return time.Saturday
	default:
		return time.Monday
	}
}

func extractLocation(s string) (string, string) {
	idx := strings.Index(s, "@")
	if idx == -1 {
		return "", s
	}

	rest := s[idx+1:]
	// Quoted location: @"..." or @'...'
	if len(rest) > 1 && (rest[0] == '"' || rest[0] == '\'') {
		quote := rest[0]
		end := strings.IndexByte(rest[1:], quote)
		if end != -1 {
			loc := strings.TrimSpace(rest[1 : end+1])
			cleaned := s[:idx] + " " + rest[end+2:]
			return loc, cleaned
		}
	}

	// Unquoted location: take consecutive tokens until end or another marker
	var words []string
	fields := strings.Fields(rest)
	for _, word := range fields {
		if strings.HasPrefix(word, "#") || strings.HasPrefix(word, "p") && len(word) == 2 && word[1] >= '1' && word[1] <= '4' {
			break
		}
		words = append(words, word)
	}

	if len(words) == 0 {
		return "", s
	}

	loc := strings.Join(words, " ")
	cleaned := strings.Replace(s, "@"+loc, " ", 1)
	return loc, cleaned
}

// ExtractRecurrence is the exported version of extractRecurrence.
func ExtractRecurrence(s string) (string, string) {
	return extractRecurrence(s)
}

// ExtractDueDate is the exported version of extractDueDate.
func ExtractDueDate(s string, now time.Time) (string, string) {
	return extractDueDate(s, now)
}

func parseMonth(m string) int {
	clean := strings.ToLower(strings.TrimSpace(m))
	clean = strings.ReplaceAll(clean, "é", "e")
	clean = strings.ReplaceAll(clean, "û", "u")
	switch clean {
	case "january", "jan", "janvier", "janv":
		return 1
	case "february", "feb", "fevrier", "fevr", "fev":
		return 2
	case "march", "mar", "mars":
		return 3
	case "april", "apr", "avril", "avr":
		return 4
	case "may", "mai":
		return 5
	case "june", "jun", "juin", "jui":
		return 6
	case "july", "jul", "juillet", "juil":
		return 7
	case "august", "aug", "aout", "aou":
		return 8
	case "september", "sep", "sept", "septembre":
		return 9
	case "october", "oct", "octobre":
		return 10
	case "november", "nov", "novembre":
		return 11
	case "december", "dec", "decembre":
		return 12
	default:
		return 0
	}
}
