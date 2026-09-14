import { useEffect, useState, type CSSProperties } from 'react';
import {
  loadAvailability,
  saveAvailability,
  SLOT_CHOICES,
  weekStartsOn,
  type Availability,
} from '../lib/appointments';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Weekly availability editor (provider).
//
// One row per weekday: an on/off toggle, a start and end time, plus a shared
// slot length and buffer. Saving upserts the enabled days and deletes the
// disabled ones.
// ---------------------------------------------------------------------------

type Row = { enabled: boolean; start: string; end: string; slot: number; buffer: number };

const DEFAULT_ROW: Row = { enabled: false, start: '09:00', end: '17:00', slot: 30, buffer: 0 };

const initialRows = (): Record<number, Row> => {
  const rows: Record<number, Row> = {};
  for (let day = 0; day < 7; day += 1) {
    // Weekdays default on, weekend off — a sensible starting point, not a rule.
    rows[day] = {
      ...DEFAULT_ROW,
      enabled: day >= 1 && day <= 5,
      slot: 30,
    };
  }
  return rows;
};

/** 'HH:MM:SS' from Postgres -> 'HH:MM' for <input type="time">. */
const toInputTime = (value: string): string => String(value ?? '').slice(0, 5);

export default function AvailabilityEditor({ providerId }: { providerId: string }) {
  const { t, locale } = useLang();
  const [rows, setRows] = useState<Record<number, Row>>(initialRows);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!providerId) return;
      const rules = await loadAvailability(providerId);
      if (cancelled || rules.length === 0) return;

      const next = initialRows();
      for (let day = 0; day < 7; day += 1) next[day] = { ...DEFAULT_ROW, enabled: false };
      for (const rule of rules) {
        next[Number(rule.weekday)] = {
          enabled: true,
          start: toInputTime(rule.start_time),
          end: toInputTime(rule.end_time),
          slot: Number(rule.slot_minutes) || 30,
          buffer: Number(rule.buffer_minutes) || 0,
        };
      }
      setRows(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const update = (day: number, patch: Partial<Row>) =>
    setRows((previous) => ({ ...previous, [day]: { ...previous[day], ...patch } }));

  const save = async () => {
    setBusy(true);
    setSaved(false);

    const rules: Availability[] = Object.entries(rows)
      .filter(([, row]) => row.enabled)
      .map(([day, row]) => ({
        id: '',
        provider_id: providerId,
        weekday: Number(day),
        start_time: `${row.start}:00`,
        end_time: `${row.end}:00`,
        slot_minutes: row.slot,
        buffer_minutes: row.buffer,
      }));

    const ok = await saveAvailability(providerId, rules);
    setSaved(ok);
    setBusy(false);
  };

  // Render the week from the locale's first day so the grid matches the calendar.
  const first = weekStartsOn(locale);
  const ordered = Array.from({ length: 7 }, (_, index) => (first + index) % 7);

  // A fixed week gives Intl stable weekday names, in the right order.
  const weekdayName = (weekday: number): string => {
    const sunday = new Date(2024, 0, 7); // a Sunday
    const date = new Date(sunday);
    date.setDate(sunday.getDate() + weekday);
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date);
  };

  return (
    <div className="panel" style={styles.panel}>
      <div className="eyebrow">{t('cal.availability')}</div>

      <ul style={styles.list}>
        {ordered.map((day) => {
          const row = rows[day];
          return (
            <li key={day} style={styles.row}>
              <label style={styles.toggle}>
                <input
                  type="checkbox"
                  checked={row.enabled}
                  aria-label={weekdayName(day)}
                  onChange={(event) => update(day, { enabled: event.target.checked })}
                />
                <span>{weekdayName(day)}</span>
              </label>

              <input
                className="input"
                type="time"
                dir="ltr"
                aria-label={`${weekdayName(day)} start`}
                disabled={!row.enabled}
                value={row.start}
                onChange={(event) => update(day, { start: event.target.value })}
                style={styles.time}
              />
              <span aria-hidden="true">–</span>
              <input
                className="input"
                type="time"
                dir="ltr"
                aria-label={`${weekdayName(day)} end`}
                disabled={!row.enabled}
                value={row.end}
                onChange={(event) => update(day, { end: event.target.value })}
                style={styles.time}
              />
            </li>
          );
        })}
      </ul>

      <div style={styles.options}>
        <label style={styles.option}>
          <span>{t('cal.availability')}</span>
          <select
            className="input"
            aria-label="Slot length"
            value={rows[first].slot}
            onChange={(event) =>
              setRows((previous) => {
                const next = { ...previous };
                for (const day of Object.keys(next)) {
                  next[Number(day)] = { ...next[Number(day)], slot: Number(event.target.value) };
                }
                return next;
              })
            }
          >
            {SLOT_CHOICES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
        </label>

        <label style={styles.option}>
          <span>Buffer</span>
          <input
            className="input"
            type="number"
            min={0}
            max={120}
            aria-label="Buffer minutes"
            value={rows[first].buffer}
            onChange={(event) =>
              setRows((previous) => {
                const next = { ...previous };
                for (const day of Object.keys(next)) {
                  next[Number(day)] = { ...next[Number(day)], buffer: Number(event.target.value) };
                }
                return next;
              })
            }
            style={styles.buffer}
          />
        </label>
      </div>

      <button type="button" className="primary-button" disabled={busy} aria-busy={busy} onClick={() => void save()}>
        {saved ? t('call.copied') : 'Save'}
      </button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: { display: 'grid', gap: '0.7rem' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.45rem' },
  row: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' },
  toggle: { display: 'inline-flex', alignItems: 'center', gap: '0.45rem', minWidth: '9rem', fontSize: '0.84rem' },
  time: { width: '7rem', minHeight: 40 },
  options: { display: 'flex', gap: '0.8rem', flexWrap: 'wrap' },
  option: { display: 'grid', gap: '0.3rem', fontSize: '0.78rem', color: 'var(--text-muted, #557b76)', fontWeight: 700 },
  buffer: { width: '5.5rem', minHeight: 40 },
};
