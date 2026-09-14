import type { Appointment } from './appointments';
import { formatDayLong, formatRange } from './appointments';

// ---------------------------------------------------------------------------
// Appointment reminder emails (Brevo / Sendinblue transactional API).
//
// STUB — the request is fully built and returned but deliberately NOT sent.
// The project's standing rule is zero API keys, and a Brevo key has to live
// somewhere; when this is wired it belongs in a server-side cron job with the
// key in an environment variable, POSTing exactly the object returned here to
// https://api.brevo.com/v3/smtp/email
//
// Templates are locale-aware with an English fallback: `locale` is honoured
// where a translation exists, otherwise `en` is used. Supplying the missing
// translations is a matter of extending SUBJECTS / BODIES below.
// ---------------------------------------------------------------------------

export type ReminderKind = 'confirmation' | 'reminder24h' | 'reminder1h';

export type ReminderPayload = {
  to: string;
  subject: string;
  html: string;
  /** ISO time the reminder should go out (cron reads this later). */
  sendAt: string;
};

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
 * Builds the reminder email for an appointment. Returns the payload rather than
 * sending it — see the header. `kind` decides which of the three goes out.
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
    when: `${formatDayLong(params.appointment.start_at, params.locale)} · ${formatRange(
      params.appointment.start_at,
      params.appointment.end_at,
      params.locale,
    )}`,
    link: params.joinUrl,
  };

  // 24h / 1h before the start.
  const startMs = new Date(params.appointment.start_at).getTime();
  const leadMs = kind === 'reminder24h' ? 24 * 3600_000 : kind === 'reminder1h' ? 3600_000 : 0;

  return {
    to: params.to,
    subject: fill(template.subject, vars),
    html: `<p>${fill(template.body, vars).replace(/\n/g, '<br/>')}</p>`,
    sendAt: new Date(startMs - leadMs).toISOString(),
  };
};
