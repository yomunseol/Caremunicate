// ---------------------------------------------------------------------------
// Time-grid geometry — the Google Calendar overlap model.
//
// Two rules, and nothing else:
//
//   1. Events that intersect in TIME are laid side by side. Overlap is
//      transitive: A∩B and B∩C put A, B and C in one group even when A and C
//      never touch. Members of a group are packed into the fewest columns,
//      each event taking the first column that is free when it starts.
//   2. Inside a group every event gets the SAME width — 100% / columns — and
//      left = column × width. Nothing is stacked behind anything and nothing is
//      hidden, so a column count can only grow when an event genuinely needs a
//      new column.
//
// Vertical geometry is minutes-from-midnight: top = start, height = duration,
// both as a percentage of the 24-hour day so any gutter height works.
// ---------------------------------------------------------------------------

export const DAY_MINUTES = 24 * 60;

/** A block is never thinner than this, so a 15-minute event stays clickable. */
export const MIN_EVENT_MINUTES = 20;

export type PositionedEvent<T> = {
  event: T;
  /** Column within its overlap group, 0-based. */
  column: number;
  /** Columns in the group — drives both width and offset. */
  columns: number;
  topPct: number;
  heightPct: number;
  leftPct: number;
  widthPct: number;
};

type TimeSpan = { start: Date; end: Date };

export const startOfDay = (date: Date): Date => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

export const addDays = (date: Date, days: number): Date => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};

/**
 * The seven days of the week that CONTAINS `anchor` — the locale's week-start
 * (`weekStarts`, 0 = Sunday) through week-end, at local midnight.
 *
 * Always exactly seven entries: never a month-length column set, never two
 * weeks stacked, never a repeated week row. This is the ONLY week day list.
 */
export const weekDaysOf = (anchor: Date, weekStarts: number): Date[] => {
  const day = startOfDay(anchor);
  const offset = (day.getDay() - weekStarts + 7) % 7;
  const start = addDays(day, -offset);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
};

/** Wall-clock minutes since local midnight — 0..1439. */
export const minutesOfDay = (date: Date): number => date.getHours() * 60 + date.getMinutes();

/**
 * Split events into transitively-overlapping groups.
 *
 * Sorted by start; a group stays open until an event begins at or after the
 * latest end seen so far. Touching counts as NOT overlapping: 09:00–10:00 and
 * 10:00–11:00 are two groups, which is what a calendar should look like.
 */
export const overlapGroups = <T extends TimeSpan>(events: T[]): T[][] => {
  const sorted = [...events].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime(),
  );

  const groups: T[][] = [];
  let current: T[] = [];
  let groupEnd = Number.NEGATIVE_INFINITY;

  for (const event of sorted) {
    if (current.length > 0 && event.start.getTime() >= groupEnd) {
      groups.push(current);
      current = [];
      groupEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(event);
    groupEnd = Math.max(groupEnd, event.end.getTime());
  }

  if (current.length > 0) groups.push(current);
  return groups;
};

/**
 * Position every event that touches `day` on that day's grid.
 *
 * The page is clipped to the day being drawn: an event that began yesterday
 * starts at 00:00 and one that runs past midnight ends at 24:00, so a
 * multi-day appointment can never overflow the column it belongs to.
 */
export const layoutDay = <T extends TimeSpan & { id: string }>(
  events: T[],
  day: Date,
): PositionedEvent<T>[] => {
  const dayStart = startOfDay(day).getTime();

  const clamp = (date: Date): number =>
    Math.min(DAY_MINUTES, Math.max(0, Math.round((date.getTime() - dayStart) / 60_000)));

  const positioned: PositionedEvent<T>[] = [];

  for (const group of overlapGroups(events)) {
    // Each column remembers when the event last placed in it finishes.
    const columnEnds: number[] = [];
    const placed: Array<{ event: T; column: number; start: number; end: number }> = [];

    for (const event of group) {
      const start = event.start.getTime();
      let column = columnEnds.findIndex((endsAt) => endsAt <= start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(Number.NEGATIVE_INFINITY);
      }
      columnEnds[column] = event.end.getTime();
      placed.push({ event, column, start: clamp(event.start), end: clamp(event.end) });
    }

    const columns = columnEnds.length;
    const width = 100 / columns;

    for (const item of placed) {
      const top = item.start;
      // Always at least MIN_EVENT_MINUTES tall, never past the end of the day.
      const height = Math.min(
        DAY_MINUTES - top,
        Math.max(MIN_EVENT_MINUTES, item.end - item.start),
      );

      positioned.push({
        event: item.event,
        column: item.column,
        columns,
        topPct: (top / DAY_MINUTES) * 100,
        heightPct: (height / DAY_MINUTES) * 100,
        leftPct: item.column * width,
        widthPct: width,
      });
    }
  }

  return positioned;
};

/** Does this event touch the given local day at all? */
export const spansDay = (event: TimeSpan, day: Date): boolean => {
  const from = startOfDay(day).getTime();
  const to = addDays(startOfDay(day), 1).getTime();
  return event.start.getTime() < to && event.end.getTime() > from;
};

/** How far forward the Schedule list looks. */
export const SCHEDULE_WINDOW_DAYS = 30;

/**
 * Bucket items by their LOCAL day key, keeping ONLY days that carry at least one
 * item — an empty day, and so an empty week, produces no entry at all.
 *
 * `fromKey` is inclusive and `untilKey` exclusive, both 'YYYY-MM-DD' from
 * lib/time's dayKey, which sorts chronologically as a string. An item whose key
 * cannot be derived (dayKey returns '') is dropped, never landed on a phantom
 * day. Days and each day's items come back sorted.
 */
export const groupByDay = <T extends { start_at: string }>(
  items: T[],
  keyOf: (item: T) => string,
  fromKey: string,
  untilKey: string,
): Array<[string, T[]]> => {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key || key < fromKey || key >= untilKey) continue;
    byDay.set(key, [...(byDay.get(key) ?? []), item]);
  }

  return [...byDay.entries()]
    .map(([key, list]) => [key, [...list].sort((a, b) => a.start_at.localeCompare(b.start_at))] as [string, T[]])
    .sort(([a], [b]) => a.localeCompare(b));
};

/**
 * The 24 hour-gutter labels — the hour AXIS, not a clock reading.
 *
 * `hour: 'numeric'` with h23 lets each locale use its own hour pattern, so ko
 * reads 0시…23시 with no leading zero and never the forced pad that
 * `hour: '2-digit'` produced ('00시'). en/ar/fr/de legitimately pad under h23
 * ("00", "00 h", "00 Uhr") — that is their convention, not a pad we imposed.
 *
 * Clock times INSIDE blocks and chips stay padded HH:MM (fmtTime in lib/time).
 */
export const hourLabels = (locale: string): string[] =>
  Array.from({ length: 24 }, (_, hour) =>
    new Intl.DateTimeFormat(locale, { hour: 'numeric', hourCycle: 'h23' }).format(
      new Date(2024, 0, 1, hour),
    ),
  );
