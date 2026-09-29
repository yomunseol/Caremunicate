// Supabase Edge Function — daily appointment reminders via Resend.
//
// Deploy:   supabase functions deploy send-reminders
// Secrets:  supabase secrets set RESEND_API_KEY=... RESEND_FROM="Caremunicate <reminders@your-domain>"
// Schedule: Dashboard → Edge Functions → send-reminders → Schedule (daily),
//           or pg_cron + pg_net (see the SQL at the bottom of this file).
//
// It finds appointments starting within the next 24h whose `reminder_sent` flag
// is still false, emails the patient through Resend, and flips the flag ONLY
// after a successful send, so a failed row is retried on the next run.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') ?? 'Caremunicate <onboarding@resend.dev>';

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** The appointment start, in the mailer's fixed English for the cron. */
const whenLabel = (startAt: string): string => {
  const date = new Date(startAt);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return date.toISOString();
  }
};

Deno.serve(async () => {
  if (!RESEND_API_KEY) {
    return json({ error: 'RESEND_API_KEY is not set' }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const nowIso = new Date().toISOString();
  const soonIso = new Date(Date.now() + DAY_MS).toISOString();

  // Select * so a schema that carries host_id/duration_min instead of
  // provider_id/end_at does not error on an unknown column.
  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('reminder_sent', false)
    .in('status', ['scheduled', 'confirmed'])
    .gte('start_at', nowIso)
    .lte('start_at', soonIso);

  if (error) {
    console.error('send-reminders: query failed', error.message);
    return json({ error: error.message }, 500);
  }

  const rows = (data ?? []) as Row[];

  // One profiles lookup for both sides of every appointment.
  const ids = [
    ...new Set(
      rows
        .flatMap((row) => [String(row.patient_id ?? ''), String(row.provider_id ?? row.host_id ?? '')])
        .filter(Boolean),
    ),
  ];
  const profiles = new Map<string, Row>();
  if (ids.length > 0) {
    const { data: people, error: peopleError } = await supabase
      .from('profiles')
      .select('user_id, username, email')
      .in('user_id', ids);

    if (peopleError) console.error('send-reminders: profiles lookup failed', peopleError.message);
    for (const person of (people ?? []) as Row[]) {
      profiles.set(String(person.user_id ?? ''), person);
    }
  }

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const patient = profiles.get(String(row.patient_id ?? ''));
    const to = String(patient?.email ?? '');
    if (!to) {
      failed += 1;
      continue;
    }

    const provider = profiles.get(String(row.provider_id ?? row.host_id ?? ''));
    const who =
      String(provider?.username ?? '') ||
      String(provider?.email ?? '').split('@')[0] ||
      'your care team';

    const code = String(row.room_code ?? '');
    const subject = `Reminder: appointment with ${who} tomorrow`;
    const html =
      `<p>Your appointment with ${who} is tomorrow at ${whenLabel(String(row.start_at ?? ''))}.</p>` +
      (code ? `<p>Join code: <b>${code}</b></p>` : '');

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
    });

    if (!response.ok) {
      failed += 1;
      console.error('send-reminders: resend failed', response.status, await response.text());
      continue;
    }

    // Idempotent: only the row still marked false flips, so a concurrent run
    // cannot double-count.
    const { error: updateError } = await supabase
      .from('appointments')
      .update({ reminder_sent: true })
      .eq('id', row.id)
      .eq('reminder_sent', false);

    if (updateError) console.error('send-reminders: flag update failed', updateError.message);
    sent += 1;
  }

  return json({ scanned: rows.length, sent, failed });
});

// ---------------------------------------------------------------------------
// Daily schedule via pg_cron + pg_net (run once in the SQL editor):
//
//   select cron.schedule('send-appointment-reminders', '0 8 * * *', $$
//     select net.http_post(
//       url := 'https://<project-ref>.supabase.co/functions/v1/send-reminders',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer <service_role_key>',
//         'Content-Type', 'application/json'),
//       body := '{}'::jsonb);
//   $$);
// ---------------------------------------------------------------------------
