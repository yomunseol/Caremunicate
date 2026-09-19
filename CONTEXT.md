# CONTEXT.md — Caremunicate

> **Read this first.** Every future change reads CONTEXT.md before touching code
> and updates it when the architecture moves. `HANDOFF.md` is older and
> superseded by this file.

## Mission

Multilingual (10 locales) healthcare-communication platform: patients reach
providers, providers reach patients. Calm mint design. Zero-dollar
infrastructure — no paid services and no keys beyond Supabase's own.

## Stack

- **Vercel** frontend (React 18 + TypeScript + Vite). No backend app server.
- **Supabase** = auth + Postgres + Realtime + Storage.
- **Own WebRTC call engine** — no Jitsi, no corsproxy, no third-party calling.
- **Overpass** through our own `/api/overpass` route (`server/overpass.ts` core;
  mirrors rotate server-side, 15s each).
- **Brevo** for transactional email.
- **Leaflet** maps (OpenStreetMap tiles), wrapped in `isolation: isolate` so its
  panes never escape above the app chrome.
- Zero new npm dependencies unless the user names one explicitly.

## Roles

`patient | doctor | department | hospital`.

`is_provider()` = doctor / department / hospital (`src/lib/roles.ts`).
Provider-side gates must use `isProvider(role)`, never `role === 'doctor'`.

## Plans — two families

- **Patients:** `basic` · `plus` · `pro`.
- **Providers:** `doctor` · `department` · `hospital` — **the plan mirrors the
  role**: a doctor account is on the `doctor` plan, a department on
  `department`, a hospital on `hospital`.
- A role NEVER displays the other family's tiers.
- **Writes:** patient tiers use a plain
  `from('profiles').update({ plan }).eq('user_id', id)`; provider tiers use
  `rpc('set_own_plan', { p_plan })` — the argument key is **`p_plan`**, never
  `plan`. Either way the client re-reads `profiles.plan`, so the badge updates
  without a reload.
- Legacy ids (`starter`, `independent-doctor`, `practice`, `organization`) alias
  onto the provider family (`LEGACY_PLAN_ALIASES`).
- Signup lands providers on their role's plan and patients on `basic`.
- The badge is driven by `profiles.plan`, read live from the row. Plan and
  certification are separate concepts and never share a card or a sentence.

## Call invariants

- Word codes (1024-word bank, 4 distinct words) are the only public identifier;
  UUIDs are internal (`call:${room.id}`) and must never render.
- ONE `/call` hub (three cards) and ONE `<CallLayer/>` — no duplicate surfaces.
- Personal rooms exist for every user.
- Lobby / password / lock / kick policies (client-enforced, signalled over the
  realtime channel).
- Caps 720p / 30fps / 900 kbps, spotlight guard, adaptive 720→480→360→audio.

## Z-scale

contained maps (`isolation: isolate`) < header 1100 < backdrop 1900 <
dropdown / modal 2000 < CallLayer 3000 < toasts 3500.

## i18n / RTL

- Locales: `en, fr, es, ko, zh, pt, de, it, ar, he`. `ar` + `he` are RTL.
- `<html dir>` and `<html lang>` switch with the locale.
- Logical CSS only (no physical `left` / `right`); `t()` wraps interpolations in
  `<bdi>`; Latin content (codes, emails) carries `dir="ltr"`.

## Design

Mint tokens (`--accent`, `--accent-strong`, `--accent-soft`, `--line`, `--shadow`,
`--text*`). Spacing: 24px card gap, 24px card padding, 12–16px inner. Rounded-2xl
tiles. Meet skin + Zoom muscles for the call UI.

## DB summary

`profiles(role, plan, is_admin, verification_status, call_prefs)` ·
`call_rooms(code, host, status, lobby / password / lock / share / autoMute /
max / personal)` — maintained in Supabase, not in this repo ·
`appointments` · `availability` · `emergency_alerts` · bucket
`verification-docs` (private).

## Booking & appointments — the request flow

- Booking is a **request**, never a room: `rpc('request_appointment', {
  p_host_id, p_start_at, p_duration_min, p_note })`. No room exists until the
  host approves, so the success panel shows no code.
- Host approval: `generateWordCode()` then `rpc('respond_appointment', {
  p_appointment_id, p_approve: true, p_code })`, retrying up to 10× on `23505`
  with a FRESH code. Decline is the same call with `p_approve: false`.
- **The owner column may be `host_id` or `provider_id`** — the client tolerates
  both; a schema error (42703/42P10/PGRST204) is the only thing that retries.
- `room_id`/`room_code` are optional. `hasRoom()` gates on both; `canJoin()`
  requires status `scheduled|confirmed` + a real room + the T−10min window.
- **There is no rendered `end_at`.** A range is computed:
  `endAt(appt) = start_at + (duration_min ?? 30)`.
- Calendar views are **Week / Month / Schedule only** (the Day view was
  deleted). Week owns the viewport — body scroll locked, one internal scroller,
  48px rows, sticky 40px header. Month cells are a fixed 112px.

## Notifications

- `notifications(id, user_id, type, payload jsonb, read, created_at)`; payload
  carries `ref_id` (legacy `appointment_id`), `patient_id`, `start_at`, `code`.
- Types are exactly `appointment_requested`, `appointment_approved`,
  `appointment_declined`, `appointment_cancelled`, `call_missed`, `system`. An
  unknown type warns in dev and renders a neutral row — never blank.
- The bell sits in the header nav **between the language pill and the Calls
  pill**. Approve/Decline show only when the current user is the **host**,
  resolved from the appointment by `ref_id` — never from profile role or a
  payload flag.
- Requester names come from `appointment.patient_id → profiles` (username, else
  email prefix). `Patient` is the fallback for a failed lookup; the word
  `Participant` never renders.
- Realtime: a `postgres_changes` INSERT subscription filtered to the user bumps
  the badge; the unread count is a `count` query on mount.

## Time

- Everything goes through `src/lib/time.ts`. `parseDate(value, tag)` returns
  null (never throws) and warns once per tag; `fmtTime`/`fmtDate`/`fmtDateTime`
  return `'—'` **for display only** and always use `hourCycle: 'h23'`.
- `slotDate(dateStr, 'HH:MM')` is the only way to build a slot — never
  `new Date('09:00')`, which is an Invalid Date.
- A missing `{{var}}` renders as an empty string. **Never interpolate `'—'`
  into a sentence** — a visible dash in interpolated copy is a bug.

## Overlays, toasts, errors

- **One toast container**: fixed top-centre below the header, z-index 3500,
  pointer-events-none, portaled to `<body>`. Nothing renders a toast inline.
- **Any fixed overlay is portaled to `<body>`.** `.panel` carries an animation
  transform, so it is a containing block for `position: fixed`; an un-portaled
  dialog is trapped inside its card.
- Every route is wrapped in the `ErrorBoundary` (mint card, raw message, dev
  component stack, Reload).

## NEVER

- No Jitsi / corsproxy / third-party calling or map services.
- No UUID in the UI or in URLs.
- No raw `{{token}}` reaching the UI.
- No physical `left` / `right` CSS.
- No patient-tier names on providers, or provider-tier names on patients.
- No new third-party paid services.

## Rule

Every future change reads CONTEXT.md first and updates it when the architecture
moves.
