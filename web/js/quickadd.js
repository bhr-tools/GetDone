// Client-side instant tokenizer and preview for quick add & task detail title
// Fully bilingual (English & French) matching internal/parser/quickadd.go

const MONTH_NAMES = {
  january: 1, jan: 1, janvier: 1, janv: 1,
  february: 2, feb: 2, février: 2, fevrier: 2, févr: 2, fevr: 2, fév: 2, fev: 2,
  march: 3, mar: 3, mars: 3,
  april: 4, apr: 4, avril: 4, avr: 4,
  may: 5, mai: 5,
  june: 6, jun: 6, juin: 6, jui: 6,
  july: 7, jul: 7, juillet: 7, juil: 7,
  august: 8, aug: 8, août: 8, aout: 8, aoû: 8, aou: 8,
  september: 9, sep: 9, sept: 9, septembre: 9,
  october: 10, oct: 10, octobre: 10,
  november: 11, nov: 11, novembre: 11,
  december: 12, dec: 12, décembre: 12, decembre: 12, déc: 12,
};

const MONTH_PATTERN = 'january|janvier|janv|jan|february|f[eé]vrier|f[eé]vr|f[eé]v|feb|march|mars|mar|april|avril|avr|apr|may|mai|june|juin|jui|jun|july|juillet|juil|jul|august|ao[uû]t|ao[uû]|aug|september|septembre|sept|sep|october|octobre|oct|november|novembre|nov|december|d[eé]cembre|d[eé]c|dec';

const WEEKDAYS = {
  sunday: 0, dimanche: 0, sun: 0,
  monday: 1, lundi: 1, mon: 1,
  tuesday: 2, mardi: 2, tue: 2,
  wednesday: 3, mercredi: 3, wed: 3,
  thursday: 4, jeudi: 4, thu: 4,
  friday: 5, vendredi: 5, fri: 5,
  saturday: 6, samedi: 6, sat: 6,
};

function normalizeMonth(m) {
  const clean = m.toLowerCase().replace(/é/g, 'e').replace(/û/g, 'u').trim();
  return MONTH_NAMES[clean] || MONTH_NAMES[m.toLowerCase().trim()] || 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function nextWeekdayDate(now, targetDay) {
  const curDay = now.getDay();
  let diff = targetDay - curDay;
  if (diff <= 0) diff += 7;
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  return d;
}

export function parseQuickTokens(text, now = new Date(), ignoredTokens = null) {
  const result = {
    title: text,
    cleanTitle: text,
    project: null,
    priority: null,
    dueDate: null,
    dueDateLabel: null,
    recurrence: null,
    recurrenceLabel: null,
    location: null,
    tokens: [],
  };

  if (!text || typeof text !== 'string') return result;

  const isIgnored = (type) => {
    if (!ignoredTokens) return false;
    if (typeof ignoredTokens.has === 'function') return ignoredTokens.has(type);
    if (Array.isArray(ignoredTokens)) return ignoredTokens.includes(type);
    return false;
  };

  let work = text;

  // 1. Priority (p1..p3 or !1..!3)
  const pMatch = work.match(/(?:^|\s)(?:p|!)([1-3])(?:\s|$)/i);
  if (pMatch) {
    const prio = parseInt(pMatch[1], 10);
    if (!isIgnored('priority')) {
      result.priority = prio;
      result.tokens.push({
        type: 'priority',
        text: pMatch[0].trim(),
        value: prio,
        label: `P${prio}`,
      });
      work = work.replace(pMatch[0], ' ');
    }
  }

  // 2. Recurrence
  const recurrPatterns = [
    { re: /\bcron:([^\s]+(?:\s+[^\s]+){4})\b/i, rule: (m) => `cron:${m[1].trim()}`, label: (m) => `Cron: ${m[1].trim()}` },
    { re: /\b(?:tous les jours ouvrés|jours ouvrés|every weekday|weekdays)\b/i, rule: () => 'weekdays', label: () => 'Weekdays' },
    { re: /\b(?:tous les jours|chaque jour|every day|daily)\b/i, rule: () => 'daily', label: () => 'Daily' },
    { re: /\b(?:toutes les semaines|chaque semaine|every week|weekly)\b/i, rule: () => 'weekly', label: () => 'Weekly' },
    { re: /\b(?:tous les mois|chaque mois|every month|monthly)\b/i, rule: () => 'monthly', label: () => 'Monthly' },
    { re: /\b(?:tous les ans|chaque annee|every year|yearly)\b/i, rule: () => 'yearly', label: () => 'Yearly' },
    { re: /\b(?:tous les lundis|chaque lundi|every monday)\b/i, rule: () => 'weekly:monday', label: () => 'Every Monday' },
    { re: /\b(?:tous les mardis|chaque mardi|every tuesday)\b/i, rule: () => 'weekly:tuesday', label: () => 'Every Tuesday' },
    { re: /\b(?:tous les mercredis|chaque mercredi|every wednesday)\b/i, rule: () => 'weekly:wednesday', label: () => 'Every Wednesday' },
    { re: /\b(?:tous les jeudis|chaque jeudi|every thursday)\b/i, rule: () => 'weekly:thursday', label: () => 'Every Thursday' },
    { re: /\b(?:tous les vendredis|chaque vendredi|every friday)\b/i, rule: () => 'weekly:friday', label: () => 'Every Friday' },
    { re: /\b(?:tous les samedis|chaque samedi|every saturday)\b/i, rule: () => 'weekly:saturday', label: () => 'Every Saturday' },
    { re: /\b(?:tous les dimanches|chaque dimanche|every sunday)\b/i, rule: () => 'weekly:sunday', label: () => 'Every Sunday' },
  ];

  for (const p of recurrPatterns) {
    const m = work.match(p.re);
    if (m) {
      if (!isIgnored('recurr') && !isIgnored('recurrence')) {
        result.recurrence = p.rule(m);
        result.recurrenceLabel = p.label(m);
        result.tokens.push({
          type: 'recurr',
          text: m[0],
          value: result.recurrence,
          label: `↻ ${result.recurrenceLabel}`,
        });
        work = work.replace(m[0], ' ');
      }
      break;
    }
  }

  // 4. Location (@"...", @'...' or @location)
  const quotedLocMatch = work.match(/@(["'])(.*?)\1/);
  if (quotedLocMatch) {
    if (!isIgnored('location')) {
      result.location = quotedLocMatch[2].trim();
      result.tokens.push({
        type: 'location',
        text: quotedLocMatch[0],
        value: result.location,
        label: `📍 ${result.location}`,
      });
      work = work.replace(quotedLocMatch[0], ' ');
    }
  } else {
    const locMatch = work.match(/@([a-zA-Z0-9_\-'.]+(?:\s+[a-zA-Z0-9_\-'.]+)*)/i);
    if (locMatch) {
      // Don't swallow following #project or priority
      const words = locMatch[1].trim().split(/\s+/);
      const locWords = [];
      for (const w of words) {
        if (w.startsWith('#') || /^p[1-4]$/i.test(w) || /^![1-4]$/.test(w)) break;
        locWords.push(w);
      }
      if (locWords.length > 0) {
        if (!isIgnored('location')) {
          result.location = locWords.join(' ');
          result.tokens.push({
            type: 'location',
            text: '@' + result.location,
            value: result.location,
            label: `📍 ${result.location}`,
          });
          work = work.replace('@' + result.location, ' ');
        }
      }
    }
  }

  // 5. Date & Time
  if (!isIgnored('date')) {
    let timeStr = '';
    let timeLabel = '';
    const timeRegex = /\b(\d{1,2})(?:(?::(\d{2}))?\s*(am|pm)|h(\d{2})?|:(\d{2}))\b/i;
    const tMatch = work.match(timeRegex);
    if (tMatch) {
      let hour = parseInt(tMatch[1], 10);
      let minute = 0;
      const ampm = tMatch[3] ? tMatch[3].toLowerCase() : '';
      if (tMatch[2]) minute = parseInt(tMatch[2], 10);
      else if (tMatch[4]) minute = parseInt(tMatch[4], 10);
      else if (tMatch[5]) minute = parseInt(tMatch[5], 10);

      if (ampm === 'pm' && hour < 12) hour += 12;
      else if (ampm === 'am' && hour === 12) hour = 0;

      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        timeStr = ` ${pad2(hour)}:${pad2(minute)}`;
        timeLabel = ` ${pad2(hour)}:${pad2(minute)}`;
        work = work.replace(tMatch[0], ' ');
      }
    }

    let targetDate = null;
    let dateTokenText = '';
    let dateLabel = '';

    const todayZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Relative keywords
    const relKeywords = [
      { re: /\b(?:aujourd'hui|aujourdhui|today|ajd)\b/i, offset: 0, label: 'Today' },
      { re: /\b(?:demain|tomorrow)\b/i, offset: 1, label: 'Tomorrow' },
      { re: /\b(?:après-demain|apres-demain|day after tomorrow)\b/i, offset: 2, label: 'Day after tomorrow' },
      { re: /\b(?:ce week-end|ce weekend|this weekend|weekend)\b/i, weekday: 6, label: 'This weekend' },
      { re: /\b(?:hier|yesterday)\b/i, offset: -1, label: 'Yesterday' },
      { re: /\b(?:lundi|monday|mon)\b/i, weekday: 1, label: 'Monday' },
      { re: /\b(?:mardi|tuesday|tue)\b/i, weekday: 2, label: 'Tuesday' },
      { re: /\b(?:mercredi|wednesday|wed)\b/i, weekday: 3, label: 'Wednesday' },
      { re: /\b(?:jeudi|thursday|thu)\b/i, weekday: 4, label: 'Thursday' },
      { re: /\b(?:vendredi|friday|fri)\b/i, weekday: 5, label: 'Friday' },
      { re: /\b(?:samedi|saturday|sat)\b/i, weekday: 6, label: 'Saturday' },
      { re: /\b(?:dimanche|sunday|sun)\b/i, weekday: 0, label: 'Sunday' },
    ];

    for (const kw of relKeywords) {
      const m = work.match(kw.re);
      if (m) {
        dateTokenText = m[0];
        dateLabel = kw.label;
        if (kw.weekday !== undefined) {
          targetDate = nextWeekdayDate(now, kw.weekday);
        } else {
          targetDate = new Date(todayZero);
          targetDate.setDate(todayZero.getDate() + kw.offset);
        }
        work = work.replace(m[0], ' ');
        break;
      }
    }

    // Day Month (e.g. 23 october, 23 oct, 15 décembre, 12 nov, 1er mai)
    if (!targetDate) {
      const dayMonthRegex = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(${MONTH_PATTERN})(?:\\s+(\\d{2,4}))?\\b`, 'i');
      const m = work.match(dayMonthRegex);
      if (m) {
        const day = parseInt(m[1], 10);
        const month = normalizeMonth(m[2]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          dateTokenText = m[0];
          let year = now.getFullYear();
          let hasYear = false;
          if (m[3]) {
            const y = parseInt(m[3], 10);
            year = y < 100 ? 2000 + y : y;
            hasYear = true;
          }
          targetDate = new Date(year, month - 1, day);
          if (!hasYear && targetDate < todayZero) {
            targetDate.setFullYear(year + 1);
          }
          dateLabel = targetDate.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
          work = work.replace(m[0], ' ');
        }
      }
    }

    // Month Day (e.g. october 23, oct 23, nov 12, décembre 15)
    if (!targetDate) {
      const monthDayRegex = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th|er)?(?:\\s+(\\d{2,4}))?\\b`, 'i');
      const m = work.match(monthDayRegex);
      if (m) {
        const month = normalizeMonth(m[1]);
        const day = parseInt(m[2], 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          dateTokenText = m[0];
          let year = now.getFullYear();
          let hasYear = false;
          if (m[3]) {
            const y = parseInt(m[3], 10);
            year = y < 100 ? 2000 + y : y;
            hasYear = true;
          }
          targetDate = new Date(year, month - 1, day);
          if (!hasYear && targetDate < todayZero) {
            targetDate.setFullYear(year + 1);
          }
          dateLabel = targetDate.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
          work = work.replace(m[0], ' ');
        }
      }
    }

    // Explicit date DD/MM or DD/MM/YYYY
    if (!targetDate) {
      const expRegex = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/;
      const m = work.match(expRegex);
      if (m) {
        const day = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          dateTokenText = m[0];
          let year = now.getFullYear();
          let hasYear = false;
          if (m[3]) {
            const y = parseInt(m[3], 10);
            year = y < 100 ? 2000 + y : y;
            hasYear = true;
          }
          targetDate = new Date(year, month - 1, day);
          if (!hasYear && targetDate < todayZero) {
            targetDate.setFullYear(year + 1);
          }
          dateLabel = `${day} ${targetDate.toLocaleDateString('en-US', { month: 'short' })}`;
          work = work.replace(m[0], ' ');
        }
      }
    }

    // ISO date YYYY-MM-DD
    if (!targetDate) {
      const isoRegex = /\b(\d{4})-(\d{2})-(\d{2})\b/;
      const m = work.match(isoRegex);
      if (m) {
        dateTokenText = m[0];
        targetDate = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        dateLabel = targetDate.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        work = work.replace(m[0], ' ');
      }
    }

    if (targetDate) {
      const yStr = targetDate.getFullYear();
      const mStr = pad2(targetDate.getMonth() + 1);
      const dStr = pad2(targetDate.getDate());
      result.dueDate = `${yStr}-${mStr}-${dStr}${timeStr}`;
      result.dueDateLabel = `${dateLabel}${timeLabel}`;
      result.tokens.push({
        type: 'date',
        text: (dateTokenText + (tMatch ? ' ' + tMatch[0] : '')).trim(),
        value: result.dueDate,
        label: result.dueDateLabel,
      });
    } else if (timeStr) {
      // Time alone implies today
      const yStr = now.getFullYear();
      const mStr = pad2(now.getMonth() + 1);
      const dStr = pad2(now.getDate());
      result.dueDate = `${yStr}-${mStr}-${dStr}${timeStr}`;
      result.dueDateLabel = `Today${timeLabel}`;
      result.tokens.push({
        type: 'date',
        text: tMatch[0],
        value: result.dueDate,
        label: result.dueDateLabel,
      });
    }
  }

  result.cleanTitle = work.trim().replace(/\s+/g, ' ');
  return result;
}

export function renderPreviewBadges(parsed, container, onDismiss = null) {
  if (!container) return;
  container.innerHTML = '';

  if (!parsed || !parsed.tokens || parsed.tokens.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';

  parsed.tokens.forEach((token) => {
    const badge = document.createElement('span');
    badge.className = `token-preview-chip ${token.type} ${token.type === 'priority' ? `priority-${token.value}` : ''}`;
    badge.textContent = token.label;
    badge.title = 'Click to dismiss';
    if (onDismiss) {
      badge.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });
      badge.addEventListener('click', (e) => {
        try {
          e.preventDefault();
          e.stopPropagation();
          onDismiss(token);
        } catch (err) {
          console.error('Error dismissing token preview chip:', err);
        }
      });
    }
    container.appendChild(badge);
  });
}
