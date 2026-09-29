import type { Appointment } from './appointments';
import { formatAppointmentRange, formatDayLong } from './appointments';
import { addMinutes } from './time';

// ---------------------------------------------------------------------------
// Appointment reminder emails (Resend transactional API).
//
// The payload is BUILT here and returned — it is NEVER sent from the browser:
// the Resend key must not reach the Vite bundle. The daily job lives in
// supabase/functions/send-reminders, which POSTs this exact shape to
// https://api.resend.com/emails (that file carries the Deno copy of the
// templates below, since an Edge Function cannot import a browser module).
//
// Templates are locale-aware with an English fallback: `locale` is honoured
// where a translation exists, otherwise `en` is used. Supplying the missing
// translations is a matter of extending SUBJECTS / BODIES below.
// ---------------------------------------------------------------------------

export type ReminderKind = 'confirmation' | 'reminder24h' | 'reminder1h';

/** The Resend request body — POST https://api.resend.com/emails. */
export type ReminderPayload = {
  from: string;
  to: string;
  subject: string;
  html: string;
  /** ISO time the reminder is due (the cron reads this later). */
  sendAt: string;
};

/**
 * Verified Resend sender. Replace with an address on your verified domain for
 * production; `onboarding@resend.dev` is Resend's no-domain testing sender.
 */
export const RESEND_FROM = 'Caremunicate <onboarding@resend.dev>';

type Template = { subject: string; body: string };

const TEMPLATES: Record<ReminderKind, Record<string, Template>> = {
  confirmation: {
    en: {
      subject: 'Appointment confirmed with {{who}}',
      body: 'Your appointment with {{who}} is booked for {{when}}.\nJoin link: {{link}}',
    },
  },
  reminder24h: {
    en: {
      subject: 'Reminder: appointment with {{who}} tomorrow',
      body: 'Your appointment with {{who}} is tomorrow at {{when}}.\nJoin link: {{link}}',
    },
  },
  reminder1h: {
    en: {
      subject: 'Reminder: appointment with {{who}} in one hour',
      body: 'Your appointment with {{who}} starts at {{when}}.\nJoin link: {{link}}',
    },
  },
};

const FALLBACK_LOCALE = 'en';

const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(vars, token) ? vars[token] : '',
  );

/**
 * Builds the reminder email for an appointment. Returns the Resend payload
 * rather than sending it — see the header. `kind` decides which of the three
 * goes out.
 */
export const sendAppointmentEmails = (
  kind: ReminderKind,
  params: {
    appointment: Appointment;
    /** Recipient address. */
    to: string;
    locale: string;
    /** The other party's display name. */
    counterpartName: string;
    /** Absolute word-code join URL. */
    joinUrl: string;
  },
): ReminderPayload => {
  const table = TEMPLATES[kind];
  const template = table[params.locale] ?? table[FALLBACK_LOCALE];

  const vars = {
    who: params.counterpartName,
    when: `${formatDayLong(params.appointment.start_at, params.locale)} · ${formatAppointmentRange(
      params.appointment,
      params.locale,
    )}`,
    link: params.joinUrl,
  };

  // 24h / 1h before the start.
  const leadMinutes = kind === 'reminder24h' ? 24 * 60 : kind === 'reminder1h' ? 60 : 0;

  return {
    from: RESEND_FROM,
    to: params.to,
    subject: fill(template.subject, vars),
    html: `<p>${fill(template.body, vars).replace(/\n/g, '<br/>')}</p>`,
    sendAt: addMinutes(params.appointment.start_at, -leadMinutes) ?? '',
  };
};
