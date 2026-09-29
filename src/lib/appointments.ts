import { supabase } from './supabase';
import { generateWordCode } from './wordcode';
import { asRows, firstRow } from './rows';
import { addMinutesToDate, dayKey, endAt, fmtTime, parseDate, slotDate } from './time';

// ---------------------------------------------------------------------------
// Appointments + availability.
//
// Times are stored in UTC (timestamptz) and rendered in the browser's local
// zone; availability is wall-clock (weekday + time of day), so it is matched
// against the LOCAL weekday of a day. Every formatter goes through
// Intl.DateTimeFormat with the active locale, and grids mirror under RTL
// because the layout uses logical properties.
//
// These tables are created by 202609190001_appointments.sql. If they are absent
// every read here degrades to empty rather than throwing.
// ---------------------------------------------------------------------------

/** 'requested' = a patient's ask awaiting the host's decision. */
export type AppointmentStatus =
  | 'requested'
  | 'scheduled'
  | 'confirmed'
  | 'completed'
  | 'cancelled';

export type Availability = {
  id: string;
  provider_id: string;
  /** 0 = Sunday .. 6 = Saturday, matching Date#getDay (local). */
  weekday: number;
  /** 'HH:MM:SS' as Postgres `time` returns it. */
  start_time: string;
  end_time: string;
  slot_minutes: number;
  buffer_minutes: number;
};

export type Appointment = {
  id: string;
  patient_id: string;
  provider_id: string;
  /** The same owner, under the newer column name; either may be present. */
  host_id?: string | null;
  room_id: string | null;
  room_code: string | null;
  start_at: string;
  /** The appointment length; the end is COMPUTED from it (default 30). */
  duration_min?: number | null;
  /** Legacy column — still read for overlap math, never rendered. */
  end_at?: string | null;
  status: AppointmentStatus;
  note: string | null;
  /** Clearance honoured on each side of this appointment (new column). */
  buffer_minutes?: number | null;
  /** Set once a 24h reminder has gone out (new column). */
  reminder_sent?: boolean | null;
};

export type Slot = { start: Date; end: Date };

/**
 * A slot plus WHY it is or is not bookable, so the UI can render every slot in
 * the day and grey out the unavailable ones instead of hiding them.
 */
export type SlotState = { start: Date; end: Date; available: boolean; reason?: 'past' | 'busy' };

export const SLOT_CHOICES = [15, 30, 45, 60] as const;

/** The Join button unlocks this long before the start. */
export const JOIN_WINDOW_MS = 10 * 60 * 1000;

/** How far ahead the booking window runs. */
export const BOOKING_WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// Locale helpers
// ---------------------------------------------------------------------------

/**
 * Locale first-day-of-week as a JS weekday (0 = Sunday). Uses Intl.Locale's
 * weekInfo where available and falls back to a sensible default.
 */
export const weekStartsOn = (locale: string): number => {
  try {
    const info = (new Intl.Locale(locale) as unknown as { weekInfo?: { firstDay?: number } })
      .weekInfo;
    // Intl weekInfo is 1 = Monday .. 7 = Sunday.
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    /* engine without weekInfo */
  }
  return /^en\b|^he\b|^ar\b/.test(locale) ? 0 : 1;
};

/** 24-hour formatting, delegated to the one safe time library. */
export const formatTime = (iso: string | Date, locale: string): string =>
  fmtTime(iso, locale, 'formatTime');

export const formatRange = (startIso: string, endIso: string, locale: string): string =>
  `${formatTime(startIso, locale)} – ${formatTime(endIso, locale)}`;

/**
 * A rendered appointment range: 'HH:MM – HH:MM', 24-hour, with the end COMPUTED
 * from start_at + duration_min. Never reads an end_at column, and never emits a
 * placeholder dash — a range with no computable end shows the start alone.
 */
export const formatAppointmentRange = (
  appointment: Pick<Appointment, 'start_at' | 'duration_min'>,
  locale: string,
): string => {
  const computed = endAt(appointment);
  const start = formatTime(appointment.start_at, locale);
  if (!computed) return start;
  return `${start} – ${formatTime(computed, locale)}`;
};

/** Shared shell: parse first (never throws), then format, else '—'. */
const formatWith = (
  value: string | number | Date | null | undefined,
  locale: string,
  options: Intl.DateTimeFormatOptions,
  tag: string,
): string => {
  const date = parseDate(value, tag);
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return '—';
  }
};

export const formatDayLong = (date: Date | string, locale: string): string =>
  formatWith(date, locale, { weekday: 'long', day: 'numeric', month: 'long' }, 'formatDayLong');

export const formatDayShort = (date: Date | string, locale: string): string =>
  formatWith(date, locale, { day: 'numeric', month: 'short' }, 'formatDayShort');

export const formatMonth = (date: Date, locale: string): string =>
  formatWith(date, locale, { month: 'long', year: 'numeric' }, 'formatMonth');

/**
 * A week's range label, start–end, from the locale's own patterns:
 * "Sep 14 – 20, 2026" in en, "2026년 9월 14일~20일" in ko. Intl.formatRange
 * collapses whichever parts the two ends share, so the shared-month short form
 * falls out per locale with no branching of our own.
 */
export const formatWeekRange = (first: Date, last: Date, locale: string): string => {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).formatRange(first, last);
  } catch {
    // An engine without formatRange: two ends, never a crash.
    return `${formatDayShort(first, locale)} – ${formatDayShort(last, locale)}`;
  }
};

export const formatWeekdayNarrow = (date: Date, locale: string): string =>
  formatWith(date, locale, { weekday: 'narrow' }, 'formatWeekdayNarrow');

/** Local (not UTC) YYYY-MM-DD, so grouping follows the user's clock. */
export const localDayKey = (date: string | number | Date): string => dayKey(date, 'localDayKey');

// ---------------------------------------------------------------------------
// Status rules
// ---------------------------------------------------------------------------

/** What to SHOW: once the end time has passed the appointment reads completed. */
export const effectiveStatus = (appointment: Appointment, now = Date.now()): AppointmentStatus => {
  if (appointment.status === 'cancelled' || appointment.status === 'completed') {
    return appointment.status;
  }
  const end = parseDate(endAt(appointment), 'effectiveStatus');
  // An unparseable end time is NOT evidence that the appointment is over.
  if (!end) return appointment.status;
  return end.getTime() <= now ? 'completed' : appointment.status;
};

/** The statuses a row may carry; anything else falls back to a neutral chip. */
export const APPOINTMENT_STATUSES: AppointmentStatus[] = [
  'requested',
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
];

/** A chip class that is always valid, whatever the server sends. */
export const statusChipClass = (status: string): string =>
  (APPOINTMENT_STATUSES as string[]).includes(status) ? `chip-${status}` : 'chip-neutral';

/** A room exists ONLY once a host has approved the request. */
export const hasRoom = (appointment: Appointment): boolean =>
  Boolean(appointment.room_id && appointment.room_code);

/**
 * Join call ONLY when the status is scheduled/confirmed and a room has actually
 * been minted. There is NO T−10min window: an approved appointment is joinable
 * immediately, so an in-progress call can be rejoined. Once the end time passes
 * effectiveStatus reads 'completed' and the gate closes again.
 */
export const canJoin = (appointment: Appointment, now = Date.now()): boolean => {
  const status = effectiveStatus(appointment, now);
  if (status !== 'scheduled' && status !== 'confirmed') return false;
  return hasRoom(appointment);
};

// ---------------------------------------------------------------------------
// Navigation hand-off: the row a write just returned, so the calendar can render
// it WITHOUT assuming a refetch will find it.
// ---------------------------------------------------------------------------
let stashedAppointment: Appointment | null = null;

export const stashAppointment = (appointment: Appointment | null): void => {
  stashedAppointment = appointment;
};

export const takeStashedAppointment = (): Appointment | null => {
  const appointment = stashedAppointment;
  stashedAppointment = null;
  return appointment;
};

/** Unlocked AND not yet finished — drives the mint pulse. */
export const isLive = (appointment: Appointment, now = Date.now()): boolean => {
  const status = effectiveStatus(appointment, now);
  if (status === 'cancelled' || status === 'completed') return false;
  const start = parseDate(appointment.start_at, 'isLive');
  const end = parseDate(endAt(appointment), 'isLive');
  if (!start || !end) return false;
  return now >= start.getTime() - JOIN_WINDOW_MS && now <= end.getTime();
};

// ---------------------------------------------------------------------------
// Slot computation
// ---------------------------------------------------------------------------

/**
 * Open slots for one date, for the booking modal.
 *
 * Expand the weekday rule from start→end in `slot_minutes` steps, then drop:
 *   - anything already in the past,
 *   - anything overlapping an appointment of any status except 'cancelled',
 *     widened by a BUFFER_MINUTES clearance so back-to-back bookings breathe.
 *
 * Slots are returned in local time and the caller formats each one with Intl.
 */
export const SLOT_BUFFER_MINUTES = 5;

/**
 * An existing appointment's occupied window, widened on each side by its OWN
 * buffer (falling back to the provider's rule buffer when the row predates the
 * column). The end is the legacy `end_at` when present, else
 * `start_at + duration_min` — the same precedence the old overlap math used,
 * now buffer-aware.
 */
const blockedInterval = (
  appointment: Pick<Appointment, 'start_at' | 'end_at' | 'duration_min' | 'buffer_minutes'>,
  fallbackBufferMinutes: number,
): { start: number; end: number } | null => {
  const start = parseDate(appointment.start_at, 'slotsForDate');
  const end = parseDate(appointment.end_at ?? endAt(appointment), 'slotsForDate');
  if (!start || !end) return null;

  const raw = Number(appointment.buffer_minutes);
  const bufferMinutes = Number.isFinite(raw) ? raw : fallbackBufferMinutes;
  const buffer = Math.max(0, bufferMinutes) * 60_000;
  return { start: start.getTime() - buffer, end: end.getTime() + buffer };
};

/**
 * The first existing appointment that would collide with `candidate`, each side
 * widened by its own buffer. This is the client-side pre-check the booking flow
 * runs BEFORE it asks the server, so an obviously-taken slot never round-trips.
 * `null` means the slot is clear.
 */
export const findConflict = (
  candidate: { start: Date; end: Date },
  existing: Appointment[],
  candidateBufferMinutes = 0,
  existingBufferFallbackMinutes = 0,
): Appointment | null => {
  const buffer = Math.max(0, candidateBufferMinutes) * 60_000;
  const start = candidate.start.getTime() - buffer;
  const end = candidate.end.getTime() + buffer;

  return (
    existing.find((appointment) => {
      if (appointment.status === 'cancelled') return false;
      const window = blockedInterval(appointment, existingBufferFallbackMinutes);
      return window !== null && start < window.end && end > window.start;
    }) ?? null
  );
};

/**
 * Every slot in the weekday rule's window for one date, each flagged bookable or
 * not — so the UI renders unavailable times DISABLED rather than hiding them.
 *
 * Expand the rule from start→end in `slot_minutes` steps and mark each:
 *   - 'past' when it has already started,
 *   - 'busy' when it overlaps a live appointment widened by its buffer.
 */
export const slotStatesForDate = (
  day: Date,
  rules: Availability[],
  booked: Appointment[],
  now = Date.now(),
): SlotState[] => {
  const rule = rules.find((item) => Number(item.weekday) === day.getDay());
  if (!rule) return [];

  const [startHour, startMinute] = rule.start_time.split(':').map(Number);
  const [endHour, endMinute] = rule.end_time.split(':').map(Number);
  if ([startHour, startMinute, endHour, endMinute].some((n) => Number.isNaN(n))) return [];

  const slotMinutes = Number(rule.slot_minutes);
  if (!(slotMinutes > 0)) return [];

  // Slots are built from the EXPLICIT day string + 'HH:MM' via slotDate() —
  // never `new Date('09:00')`, which is an invalid date.
  const dateStr = dayKey(day, 'slotsForDate');
  if (!dateStr) return [];

  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  // The provider's per-weekday buffer widens the candidate AND is the fallback
  // for a busy row whose own buffer column is absent.
  const ruleBuffer = Number(rule.buffer_minutes);
  const bufferMinutes = Number.isFinite(ruleBuffer) ? ruleBuffer : SLOT_BUFFER_MINUTES;
  const buffer = Math.max(0, bufferMinutes) * 60_000;

  const busy = booked
    .filter((appointment) => appointment.status !== 'cancelled')
    .map((appointment) => blockedInterval(appointment, bufferMinutes))
    .filter((window): window is { start: number; end: number } => window !== null);

  const toHhmm = (minutes: number): string =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

  const states: SlotState[] = [];
  for (let cursor = startMinutes; cursor + slotMinutes <= endMinutes; cursor += slotMinutes) {
    const start = slotDate(dateStr, toHhmm(cursor));
    if (!start) break;
    const end = addMinutesToDate(start, slotMinutes);

    const past = start.getTime() <= now;
    const blocked = busy.some(
      (window) => start.getTime() - buffer < window.end && end.getTime() + buffer > window.start,
    );

    const state: SlotState = { start, end, available: !past && !blocked };
    if (past) state.reason = 'past';
    else if (blocked) state.reason = 'busy';
    states.push(state);
  }

  return states;
};

/** Just the OPEN slots — the date-strip count and the bookable slot grid. */
export const slotsForDate = (
  day: Date,
  rules: Availability[],
  booked: Appointment[],
  now = Date.now(),
): Slot[] =>
  slotStatesForDate(day, rules, booked, now)
    .filter((state) => state.available)
    .map(({ start, end }) => ({ start, end }));

// ---------------------------------------------------------------------------
// Data access — every call degrades quietly if the tables are missing.
// ---------------------------------------------------------------------------

/** Display details for a set of user ids, as far as RLS allows. */
export type PersonInfo = { id: string; name: string; role: string; verified: boolean };

const toPerson = (row: Record<string, unknown>): PersonInfo => ({
  id: String(row.user_id ?? ''),
  name: String(row.username ?? '') || String(row.email ?? '').split('@')[0] || '',
  role: String(row.role ?? ''),
  // Only a literal 'verified' may light the badge.
  verified: row.verification_status === 'verified',
});

export const loadPeople = async (ids: string[]): Promise<Map<string, PersonInfo>> => {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map<string, PersonInfo>();
  if (unique.length === 0) return map;

  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, username, email, role, verification_status')
    .in('user_id', unique);

  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    return map;
  }
  for (const row of asRows<Record<string, unknown>>(data)) {
    const person = toPerson(row);
    if (person.id) map.set(person.id, person);
  }
  return map;
};

/** Every provider account, for the patient's booking picker. */
export const loadProviders = async (): Promise<PersonInfo[]> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, username, email, role, verification_status')
    .in('role', ['doctor', 'department', 'hospital']);

  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    return [];
  }
  return asRows<Record<string, unknown>>(data).map(toPerson).filter((p) => p.id);
};

/** Codes that mean "that column or unique constraint does not exist". */
const SCHEMA_MISMATCH = new Set(['42703', '42P10', 'PGRST204', 'PGRST100']);
const schemaMismatch = (code: string | null | undefined): boolean =>
  SCHEMA_MISMATCH.has(String(code ?? ''));

/**
 * The DB overlap guard raises SQLSTATE 23P01 (exclusion_violation) with the
 * message `appointment_overlap`. Both map to ONE friendly, translated key.
 */
export const OVERLAP_MESSAGE_KEY = 'cal.slotTaken';

export const isOverlapError = (error: {
  code?: string | null;
  message?: string | null;
}): boolean => error.code === '23P01' || /appointment_overlap/i.test(error.message ?? '');

/**
 * Localized weekday name for 0 = Sunday .. 6 = Saturday, from a fixed
 * reference week. Lives here (not in the editor) so the editor itself holds no
 * Date objects or timezone arithmetic.
 */
export const weekdayName = (weekday: number, locale: string): string => {
  const sunday = new Date(2024, 0, 7); // a Sunday
  const date = new Date(sunday);
  date.setDate(sunday.getDate() + weekday);
  return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date);
};

export const loadAvailability = async (providerId: string): Promise<Availability[]> => {
  if (!providerId) return [];

  const read = (ownerColumn: 'host_id' | 'provider_id') =>
    supabase
      .from('availability')
      .select('*')
      .eq(ownerColumn, providerId)
      .order('weekday', { ascending: true });

  // `host_id` is the column the editor writes; fall back to the repo
  // migration's `provider_id` if the live table still carries that.
  let { data, error } = await read('host_id');
  if (error && schemaMismatch(error.code)) {
    ({ data, error } = await read('provider_id'));
  }

  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    return [];
  }

  // Normalize the slot/buffer column names so the booking slot picker keeps
  // working whichever the table carries.
  return asRows<Record<string, unknown>>(data).map((row) => ({
    ...(row as unknown as Availability),
    slot_minutes: Number(row.slot_minutes ?? row.slot_min ?? 30),
    buffer_minutes: Number(row.buffer_minutes ?? row.buffer_min ?? 0),
  }));
};

export const loadAppointments = async (
  userId: string,
  side: 'patient' | 'provider',
): Promise<Appointment[]> => {
  if (!userId) return [];

  // NO status filter: every status — requested, scheduled, confirmed,
  // completed, cancelled — loads for the visible range and renders through the
  // colour map. The provider side tolerates BOTH the host_id and provider_id
  // column names, so a host_id table cannot silently return zero rows.
  const ownerColumns = side === 'patient' ? ['patient_id'] : ['host_id', 'provider_id'];

  for (const column of ownerColumns) {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq(column, userId)
      .order('start_at', { ascending: true });

    if (!error) return asRows<Appointment>(data);

    console.error('CALENDAR ERROR:', error.message);
    if (!schemaMismatch(error.code)) return [];
  }
  return [];
};

/**
 * When a provider is busy, as bare time ranges.
 *
 * A patient cannot read other patients' appointment rows under RLS, so this
 * goes through provider_busy_slots() which exposes only start/end.
 */
export const loadBusySlots = async (providerId: string): Promise<Appointment[]> => {
  if (!providerId) return [];
  const { data, error } = await supabase.rpc('provider_busy_slots', { p_provider: providerId });

  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    return [];
  }

  return asRows<{ start_at: string; end_at: string }>(data).map((row) => ({
    id: '',
    patient_id: '',
    provider_id: providerId,
    room_id: null,
    room_code: null,
    start_at: row.start_at,
    end_at: row.end_at,
    status: 'scheduled' as AppointmentStatus,
    note: null,
  }));
};

export const createAppointment = async (payload: {
  patientId: string;
  providerId: string;
  roomId: string | null;
  roomCode: string | null;
  start: Date;
  end: Date;
  note?: string;
}): Promise<RequestResult> => {
  const durationMin = Math.max(1, Math.round((payload.end.getTime() - payload.start.getTime()) / 60_000));

  const { data, error } = await supabase
    .from('appointments')
    .insert({
      patient_id: payload.patientId,
      provider_id: payload.providerId,
      room_id: payload.roomId,
      room_code: payload.roomCode,
      start_at: payload.start.toISOString(),
      end_at: payload.end.toISOString(),
      duration_min: durationMin,
      // A provider creating their own block confirms it outright — there is no
      // request to approve.
      status: 'confirmed',
      note: payload.note ?? null,
    })
    .select('*')
    .single();

  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    // The DB overlap guard raises 23P01 → the one friendly key. Everything else
    // self-reports its raw code.
    const overlap = isOverlapError(error);
    return { ok: false, code: overlap ? OVERLAP_MESSAGE_KEY : error.code ?? error.message };
  }
  return { ok: true, appointment: firstRow<Appointment>(data) };
};

/**
 * Mints the room for a provider-created appointment, server-side. A 23505 (the
 * code was already taken) retries with a FRESH code, up to 10 times.
 *
 * `missing` marks the FUNCTION ITSELF being absent (42883 undefined_function,
 * PGRST202 not in the schema cache) — the caller must surface that loudly and
 * stop, never silently skip room linking.
 */
export const createAppointmentRoom = async (
  appointmentId: string,
): Promise<{ ok: true; code: string } | { ok: false; code: string; missing: boolean }> => {
  let lastCode = '';

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateWordCode();
    const { error } = await supabase.rpc('create_appointment_room', {
      p_appointment_id: appointmentId,
      p_code: code,
    });

    if (!error) return { ok: true, code };

    console.error('CALENDAR ERROR:', error.message);
    lastCode = error.code ?? error.message;

    if (error.code === '42883' || error.code === 'PGRST202') {
      return { ok: false, code: lastCode, missing: true };
    }
    if (error.code !== '23505') break;
  }

  return { ok: false, code: lastCode, missing: false };
};

export const setAppointmentStatus = async (
  id: string,
  status: AppointmentStatus,
): Promise<boolean> => {
  const { error } = await supabase.from('appointments').update({ status }).eq('id', id);
  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Request flow — the server owns these writes (SECURITY DEFINER RPCs).
// ---------------------------------------------------------------------------

export type RpcResult = { ok: true } | { ok: false; code: string };

export type RequestResult =
  | { ok: true; appointment: Appointment | null }
  | { ok: false; code: string };

/** Patient: ask the host for a slot. No room exists until it is approved. */
export const requestAppointment = async (payload: {
  hostId: string;
  start: Date;
  durationMin: number;
  note?: string;
}): Promise<RequestResult> => {
  const { data, error } = await supabase.rpc('request_appointment', {
    p_host_id: payload.hostId,
    p_start_at: payload.start.toISOString(),
    p_duration_min: payload.durationMin,
    p_note: payload.note ?? null,
  });

  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    return {
      ok: false,
      code: isOverlapError(error) ? OVERLAP_MESSAGE_KEY : error.code ?? error.message,
    };
  }

  // The RPC returns the created row; normalize object / array / null.
  return { ok: true, appointment: firstRow<Appointment>(data) };
};

/** Host: accept or decline a pending request. Arg key is p_approve. */
export const respondToAppointment = async (
  appointmentId: string,
  approve: boolean,
  code?: string,
): Promise<RpcResult> => {
  const { error } = await supabase.rpc('respond_appointment', {
    p_appointment_id: appointmentId,
    p_approve: approve,
    ...(code ? { p_code: code } : {}),
  });

  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    return { ok: false, code: error.code ?? error.message };
  }
  return { ok: true };
};

/**
 * Host: accept a request. The room code is minted here and must be unique, so a
 * 23505 (unique violation) retries with a FRESH code, up to 10 times.
 */
export const approveAppointment = async (
  appointmentId: string,
): Promise<{ ok: true; code: string } | { ok: false; code: string }> => {
  let lastCode = '23505';

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateWordCode();
    const { error } = await supabase.rpc('respond_appointment', {
      p_appointment_id: appointmentId,
      p_approve: true,
      p_code: code,
    });

    if (!error) return { ok: true, code };

    console.error('CALENDAR ERROR:', error.message);
    lastCode = error.code ?? error.message;
    if (error.code !== '23505') break;
  }

  return { ok: false, code: lastCode };
};

// ---------------------------------------------------------------------------
// .ics — generated in the browser, no service involved.
// ---------------------------------------------------------------------------

/** RFC 5545: escape the characters that would break a property value. */
const escapeIcs = (value: string): string =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/** UTC timestamp in the form the format expects: 20260913T101500Z, or ''. */
const icsStamp = (iso: string | null | undefined): string => {
  const date = parseDate(iso, 'icsStamp');
  if (!date) return '';
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
};

export const buildIcs = (appointment: Appointment, title: string, description: string): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Caremunicate//Appointments//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${appointment.id}@caremunicate`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(appointment.start_at)}`,
    `DTEND:${icsStamp(endAt(appointment))}`,
    `SUMMARY:${escapeIcs(title)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

export const downloadIcs = (filename: string, contents: string): void => {
  if (typeof window === 'undefined') return;
  const blob = new Blob([contents], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.ics') ? filename : `${filename}.ics`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a beat to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
