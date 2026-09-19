// ---------------------------------------------------------------------------
// The ONE safe time library.
//
// Every date/time value that comes from a row, a payload or a URL goes through
// parseDate() first, so `new Date('')` / `new Date('27:00')` can never reach an
// Intl formatter and throw "Invalid time value". Formatters return '—' instead
// of throwing, and every clock is 24-hour (hourCycle h23).
//
// All `new Date(...)` calls live here; callers use these helpers.
// ---------------------------------------------------------------------------

const warned = new Set<string>();

/**
 * Parse anything date-like. Returns null (never throws) for empty/invalid
 * input, and warns ONCE per tag with the raw value — pass a tag naming the
 * component or helper so the console points at the source.
 */
export const parseDate = (
  value: string | number | Date | null | undefined,
  tag: string,
): Date | null => {
  if (value === null || value === undefined || value === '') {
    if (!warned.has(tag)) {
      warned.add(tag);
      console.warn(`[time] ${tag}: missing date value`, value);
    }
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    if (!warned.has(tag)) {
      warned.add(tag);
      console.warn(`[time] ${tag}: invalid date value`, value);
    }
    return null;
  }
  return date;
};

/** Local 'YYYY-MM-DD' for a parsed value, or '' when it cannot be parsed. */
export const dayKey = (value: string | number | Date | null | undefined, tag: string): string => {
  const date = parseDate(value, tag);
  if (!date) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
};

/** HH:MM, 24-hour, or '—'. */
export const fmtTime = (
  value: string | number | Date | null | undefined,
  locale: string,
  tag = 'fmtTime',
): string => {
  const date = parseDate(value, tag);
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return '—';
  }
};

/** A date without the clock, or '—'. */
export const fmtDate = (
  value: string | number | Date | null | undefined,
  locale: string,
  tag = 'fmtDate',
): string => {
  const date = parseDate(value, tag);
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date);
  } catch {
    return '—';
  }
};

/** Date + 24-hour time, or '—'. */
export const fmtDateTime = (
  value: string | number | Date | null | undefined,
  locale: string,
  tag = 'fmtDateTime',
): string => {
  const date = parseDate(value, tag);
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return '—';
  }
};

/** A new Date offset by whole minutes — the only place we call new Date(n). */
export const addMinutes = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * 60_000);

/** A new Date offset by whole days. */
export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);

/** Tonight's midnight for a parsed value, or null. */
export const startOfDay = (value: string | number | Date, tag = 'startOfDay'): Date | null => {
  const date = parseDate(value, tag);
  if (!date) return null;
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

/**
 * Build a local Date from an explicit 'YYYY-MM-DD' day string plus 'HH:MM'.
 * Never call `new Date('09:00')` — this is the only correct way.
 */
export const slotDate = (dateStr: string, hhmm: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
  return parseDate(`${dateStr}T${hhmm}:00`, 'slotDate');
};
