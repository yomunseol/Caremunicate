import { supabase } from './supabase';

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

export type AppointmentStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled';

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
  room_id: string | null;
  room_code: string | null;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  note: string | null;
};

export type Slot = { start: Date; end: Date };

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

export const formatTime = (iso: string | Date, locale: string): string =>
  new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export const formatRange = (startIso: string, endIso: string, locale: string): string =>
  `${formatTime(startIso, locale)} – ${formatTime(endIso, locale)}`;

export const formatDayLong = (date: Date | string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(date),
  );

export const formatDayShort = (date: Date | string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(date));

export const formatMonth = (date: Date, locale: string): string =>
  new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(date);

export const formatWeekdayNarrow = (date: Date, locale: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(date);

/** Local (not UTC) YYYY-MM-DD, so grouping follows the user's clock. */
export const localDayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// Status rules
// ---------------------------------------------------------------------------

/** What to SHOW: once the end time has passed the appointment reads completed. */
export const effectiveStatus = (appointment: Appointment, now = Date.now()): AppointmentStatus => {
  if (appointment.status === 'cancelled' || appointment.status === 'completed') {
    return appointment.status;
  }
  return new Date(appointment.end_at).getTime() <= now ? 'completed' : appointment.status;
};

/** The Join button is disabled until T−10min, and after the call ends. */
export const canJoin = (appointment: Appointment, now = Date.now()): boolean => {
  const status = effectiveStatus(appointment, now);
  if (status === 'cancelled' || status === 'completed') return false;
  return now >= new Date(appointment.start_at).getTime() - JOIN_WINDOW_MS;
};

/** Unlocked AND not yet finished — drives the mint pulse. */
export const isLive = (appointment: Appointment, now = Date.now()): boolean => {
  const status = effectiveStatus(appointment, now);
  if (status === 'cancelled' || status === 'completed') return false;
  return (
    now >= new Date(appointment.start_at).getTime() - JOIN_WINDOW_MS &&
    now <= new Date(appointment.end_at).getTime()
  );
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

export const slotsForDate = (
  day: Date,
  rules: Availability[],
  booked: Appointment[],
  now = Date.now(),
): Slot[] => {
  const rule = rules.find((item) => Number(item.weekday) === day.getDay());
  if (!rule) return [];

  const [startHour, startMinute] = rule.start_time.split(':').map(Number);
  const [endHour, endMinute] = rule.end_time.split(':').map(Number);
  if ([startHour, startMinute, endHour, endMinute].some((n) => Number.isNaN(n))) return [];

  const length = Number(rule.slot_minutes) * 60_000;
  if (length <= 0) return [];

  // The buffer applies to the candidate, so a booking that merely touches the
  // slot edge still leaves a gap.
  const buffer = SLOT_BUFFER_MINUTES * 60_000;

  const dayEnd = new Date(day);
  dayEnd.setHours(endHour, endMinute, 0, 0);

  const busy = booked
    .filter((appointment) => appointment.status !== 'cancelled')
    .map((appointment) => ({
      start: new Date(appointment.start_at).getTime(),
      end: new Date(appointment.end_at).getTime(),
    }));

  const slots: Slot[] = [];
  const cursor = new Date(day);
  cursor.setHours(startHour, startMinute, 0, 0);

  while (cursor.getTime() + length <= dayEnd.getTime()) {
    const start = new Date(cursor);
    const end = new Date(cursor.getTime() + length);

    const blocked = busy.some(
      (item) => start.getTime() - buffer < item.end && end.getTime() + buffer > item.start,
    );

    if (!blocked && start.getTime() > now) slots.push({ start, end });
    cursor.setTime(cursor.getTime() + length);
  }

  return slots;
};

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
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
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
  return ((data ?? []) as Array<Record<string, unknown>>).map(toPerson).filter((p) => p.id);
};

/** Codes that mean "that column or unique constraint does not exist". */
const SCHEMA_MISMATCH = new Set(['42703', '42P10', 'PGRST204', 'PGRST100']);
const schemaMismatch = (code: string | null | undefined): boolean =>
  SCHEMA_MISMATCH.has(String(code ?? ''));

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
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
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
  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .eq(side === 'patient' ? 'patient_id' : 'provider_id', userId)
    .order('start_at', { ascending: true });

  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    return [];
  }
  return (data ?? []) as Appointment[];
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

  return ((data ?? []) as Array<{ start_at: string; end_at: string }>).map((row) => ({
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
}): Promise<Appointment | null> => {
  const { data, error } = await supabase
    .from('appointments')
    .insert({
      patient_id: payload.patientId,
      provider_id: payload.providerId,
      room_id: payload.roomId,
      room_code: payload.roomCode,
      start_at: payload.start.toISOString(),
      end_at: payload.end.toISOString(),
      status: 'scheduled',
      note: payload.note ?? null,
    })
    .select('*')
    .single();

  if (error) {
    console.error('CALENDAR ERROR:', error.message);
    return null;
  }
  return data as Appointment;
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
// .ics — generated in the browser, no service involved.
// ---------------------------------------------------------------------------

/** RFC 5545: escape the characters that would break a property value. */
const escapeIcs = (value: string): string =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/** UTC timestamp in the form the format expects: 20260913T101500Z. */
const icsStamp = (iso: string): string =>
  new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

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
    `DTEND:${icsStamp(appointment.end_at)}`,
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
