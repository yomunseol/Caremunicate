# CONTEXT.md — Caremunicate

> **Read this first.** Every future change reads CONTEXT.md before touching code
> and updates it when the architecture moves.

## Mission

Multilingual (10 locales) healthcare-communication platform: patients reach
providers, providers reach patients. Calm mint design. Zero-dollar
infrastructure — no paid services, and no keys beyond Supabase's own plus the
single Resend key for reminder email.

## Stack

- **Vercel** frontend (React 18 + TypeScript + Vite). No backend app server.
- **Supabase** = auth + Postgres + Realtime + Storage.
- **Own WebRTC call engine** — no Jitsi, no corsproxy, no third-party calling.
- **Resend** for transactional email (server-side only — see Reminders).
- **Overpass** through our own `/api/overpass` route (`server/overpass.ts` core;
  mirrors rotate server-side, 15s each).
- **Leaflet** maps (OpenStreetMap tiles), wrapped in `isolation: isolate` so its
  panes never escape above the app chrome.
- Zero new npm dependencies unless the user names one explicitly.

## Roles

`patient | doctor | department | hospital`.

`is_provider()` = doctor / department / hospital (`src/lib/roles.ts`).
Provider-side gates must use `isProvider(role)`, never `role === 'doctor'`.
**The role comes from `useRole()`** (`src/context/RoleContext.tsx`), which reads
`profiles.role` once (metadata is only the pre-load fallback). Never read
`user_metadata.role` directly — it goes stale and silently breaks every gate.

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
- ONE `/call` hub (two cards: join-with-code + personal line) and ONE
  `<CallLayer/>` — no duplicate surfaces. The provider-only "Start meeting"
  card is gone: the personal line is the meeting mechanism, so `createRoom()`
  has no caller and no fresh-per-meeting codes are drawn.
- Personal rooms exist for every user.
- Lobby / password / lock / kick policies (client-enforced, signalled over the
  realtime channel).
- Caps 720p / 30fps / 900 kbps, spotlight guard, adaptive 720→480→360→audio.
- **Persisted session**: `call_sessions` is opened on join and closed
  (`ended_at`) on teardown. In-call chat lives in its `chat_log` JSONB, appended
  by the `append_call_message` RPC (never a client read-modify-write) and streamed
  over a DEDICATED channel — never the `call:` signaling one.
- **Caremunicate Docs**: `clinical_docs` is one row per
  `(call_session_id, author_id)`. `edit_mode` is chosen at creation and is
  IMMUTABLE; a `meeting_only` doc locks when its session ends — enforced by RLS,
  mirrored in the panel. There is no `is_finalized` flag.
- Chat + Docs are the CallLayer's side panels (at most one open); Docs is
  provider-only, Chat is shared.
- **Quality dot**: the top-bar indicator is driven by measured inbound packet
  loss/jitter from `getStats()` (good/fair/poor), not by pending ICE state.
- **Recording**: consent-gated; `MediaRecorder` mixes local + remote audio (an
  `AudioContext` destination) plus the local camera track. The blob is uploaded
  to the `call-recordings` bucket and `recording_url` holds the **Storage path**
  — never a `blob:` URL.

## Z-scale

contained maps (`isolation: isolate`) < header 1100 < backdrop 1900 <
dropdown / modal 2000 < CallLayer 3000 < toasts 3500.

## i18n / RTL

- Locales: `en, fr, es, ko, zh, pt, de, it, ar, he`. `ar` + `he` are RTL.
- `<html dir>` and `<html lang>` switch with the locale.
- Logical CSS only (no physical `left` / `right`); `t()` wraps interpolations in
  `<bdi>`; Latin content (codes, emails) carries `dir="ltr"`.
- **CF-5 — coverage is now enforced, not eyeballed.** `npm run i18n:check`
  (`scripts/i18n-check.mjs`, wired as `prebuild`) FAILS when any locale is
  missing a master (`en`) key / has duplicates, OR when a hardcoded user-facing
  string (JSX text or `aria-label`/`title`/`placeholder`/`alt`) appears outside
  the allowlist (brand names, codes, units, symbol-only). All **10** locales carry
  **every** key. The locale set the app ships is `en, fr, es, ko, zh, pt, de, it,
  ar, he` — a deck naming `ja`/`ru` does not apply; those two are authored
  natively here as `it`/`he`.
- **Switcher persistence.** Choice lives in `localStorage`
  (`caremunicate:locale`, plus `caremunicate:dir`); `<html lang>`/`<html dir>`
  are written in a layout effect so the direction is correct on first paint. The
  custom `App`-level nav uses only logical spacing, so it mirrors under `ar`/`he`.

## Design

Mint tokens (`--accent`, `--accent-strong`, `--accent-soft`, `--line`, `--shadow`,
`--text*`). Spacing: 24px card gap, 24px card padding, 12–16px inner. Rounded-2xl
tiles. Meet skin + Zoom muscles for the call UI.

## DB summary

`profiles(user_id, username, email, role, plan, is_admin, verification_status,
call_prefs, specialty, clinic)` ·
`conversations(id, type, name, created_by, created_at, direct_key)` ·
`conversation_participants(conversation_id, user_id, role, joined_at)` ·
`messages(id, conversation_id, sender_id, content, created_at)` ·
`call_rooms(code, host, status, lobby / password / lock / share / autoMute /
max / personal)` — maintained in Supabase, not in this repo ·
`appointments(+buffer_minutes, reminder_sent, guest_name)` · `availability` ·
`emergency_alerts` · `hospitals` ·
`doctor_favorites` · `call_sessions(room_key, participant_ids, chat_log,
has_recording, recording_url, ended_at)` · `clinical_docs(call_session_id,
author_id, content, edit_mode)` · `care_plans(patient_id, provider_id, title,
status)` · `care_plan_tasks(plan_id, instruction, metric_type, frequency,
goal_count, goal_unit)` · `care_plan_logs(task_id, patient_id, log_date,
value_*)` · `email_otp_codes(user_id, code_hash, expires_at, attempts)` ·
`email_log(email, type, locale, error)` · buckets `verification-docs`,
`call-recordings` (private).

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
  requires status `scheduled|confirmed` + a real room — **no T−10min window**:
  an approved appointment is joinable immediately and stays joinable while the
  call runs (the gate closes once `effectiveStatus` reads `completed`).
- **There is no rendered `end_at`.** A range is computed:
  `endAt(appt) = start_at + (duration_min ?? 30)`.
- Calendar views are **Week / Month / Schedule only** (the Day view was
  deleted). Week owns the viewport — body scroll locked, one internal scroller,
  48px rows, sticky 40px header. Month cells are a fixed 112px.
- **CF-1**: the three booking RPCs (`request_appointment`, `respond_appointment`,
  `create_appointment_room`) are now defined in-repo by
  `202609250003_calendar_booking_repair.sql` — they were previously assumed but
  never migrated, so booking reached PostgREST with no such function ⇒
  **PGRST202** (function-not-found, NOT table-not-found). That migration also
  reconciles the column drift (both `provider_id`/`host_id`, `slot_minutes`/
  `slot_min`, `end_at`/`duration_min`), adds `'requested'` to the status CHECK,
  grants, RLS, and ends with `notify pgrst, 'reload schema'`. A missing RPC is
  surfaced as `server function missing: <fn> (<code>)`, never a bare status.
- `availability` upsert requires `UNIQUE(host_id, weekday, start_time)`;
  `appointments.room_code` needs `UNIQUE` for the fresh-code retry.
- **CF-1 amend (legacy mirror)**: `202609250003_calendar_booking_repair.sql` now
  drops `create_appointment_room(uuid,text)` and `provider_busy_slots(uuid)`
  before redefining them, adds `appointments.start_at` to the ALTER block, and
  appends an `appointments_mirror` BEFORE INSERT/UPDATE trigger that coalesces
  the legacy column spellings — `doctor_id` ↔ `provider_id`/`host_id`,
  `start_time`/`end_time` ↔ `start_at`/`end_at`, `meeting_code` ↔ `room_code`,
  `notes` ↔ `note` — plus a backfill `UPDATE` and
  `alter column doctor_id drop not null`. **This presumes the LIVE table already
  carries those legacy columns**: none of them is declared anywhere in this
  repo's migrations, and `coalesce(end_time, end_at)` only type-checks when both
  are `timestamptz`. On a table without them the appended block fails with
  **42703** at `alter column doctor_id`. Founder-run, unverified from the repo.
- **CF-4 — ad-hoc time + guest booking** (provider quick-create modal,
  `QuickCreatePopover.tsx`). With **no availability rows** the slot dropdown
  would be dead, so it is replaced by a 15-minute time picker (07:00–22:00) plus
  a duration select (15/30/45/60) and a one-click **Apply default weekly hours**
  button (Mon–Fri 09:00–18:00) that upserts `availability` rows via the CF-1
  table, then refreshes the slot dropdown. The patient field is a **combobox**
  over linked patients with an always-available `+ Guest patient` option (name
  required, ≥2 chars); a guest booking inserts an appointment with
  `patient_id NULL` + `guest_name` — founder SQL
  `202609250005_guest_booking.sql` adds the column and drops NOT NULL on
  `patient_id`. Calendar titles fall back to `guest_name` when there is no
  patient profile.
- **CF-6 — the slot is serialized, never an object** (`BookingFlow.tsx`). The
  picked slot is unpacked at selection into `{ startAt: Date, durationMin:
  number }`; `book()` sends `start_at = startAt.toISOString()` and
  `p_duration_min = Number(durationMin)`, and the Book button is gated on
  `startAt instanceof Date && !isNaN(startAt)` + a finite positive
  `durationMin`, so an invalid state never calls the RPC. The footer summary is
  ONE translated template — `t('cal.summaryLine', { date, time, duration, tz })`
  with `date`/`time` from `Intl.DateTimeFormat` — never string interpolation of
  a value object (the `,[object Object],` bug). Founder SQL
  `202609250006_request_appointment_guard.sql` adds `if p_start_at is null then
  raise exception 'invalid_start' using errcode='22007'` so a future null start
  is a readable code, not the legacy-column `23502`. Months/weekday initials
  already come from `Intl` (no hardcoded `S M T W` anywhere).

## Hospitals map — `/hospitals`

- One route (`#hospitals`), one component (`HospitalMap.tsx`), one table:
  `hospitals(id, name, latitude, longitude, osm_id, added_by)`.
- Pins are a **custom mint `L.divIcon`** (teardrop + white disc + cross). The
  default blue Leaflet marker must never render.
- Tiles are OSM raster; the location search goes through the **same-origin
  `/api/overpass`** proxy (`src/lib/hospitals.ts`) — no Nominatim, no geocoder.
- Adding is **provider-only** (`isProvider`); the row is written with
  `added_by = auth.uid()`. RLS: read for all authenticated, insert/delete own.
- The add form is **portaled to `<body>`** (the fixed-overlay rule) and carries
  its own small map for click-to-drop-pin, plus a search list.

## Doctor directory — `/doctors`

- One route (`#doctors`), one component (`DoctorList.tsx`), one save table:
  `doctor_favorites(patient_id, doctor_id)`.
- The list is `profiles WHERE role = 'doctor'` (the directory SELECT policy
  already publishes doctor rows). The name falls back username → email prefix.
- `profiles.specialty` / `profiles.clinic` are the public directory fields;
  doctor signup writes them onto the row (auth metadata is private to the user).
- The select **drops optional columns on `42703`/`PGRST204`**, so the list still
  renders on a project where the migration has not run.
- The heart toggles a favourite **optimistically** (instant) and rolls back with
  a toast if the write fails. "My favorites" is a client-side filter, patient-only
  (`isProvider` gates it).
- RLS: a favourite belongs to its patient only — select/insert/delete all gate on
  `patient_id = auth.uid()`.

## Chat — direct conversations (`#chat`, floating widget)

- Three tables: `conversations(id, type, name, created_by, created_at,
  direct_key)`, `conversation_participants(conversation_id, user_id, role,
  joined_at)` (composite PK on `(conversation_id, user_id)`), and
  `messages(id, conversation_id, sender_id, content, created_at)`.
- **`create_direct_conversation(p_user_a, p_user_b)` is the ONLY creation path.**
  RLS has NO insert policies on `conversations` / `conversation_participants`, so
  direct table inserts are impossible. The function is SECURITY DEFINER, checks
  `auth.uid()` is one of the two parties, and snapshots each side's role
  (`profiles.role`, else auth metadata) into `conversation_participants.role`.
  The snapshot CHECK allows exactly `patient | doctor | hospital` — **a
  `department` account cannot be a chat participant** (the constraint predates
  the role).
- **Idempotent by construction (CF-2).** `conversations.direct_key` holds the
  sorted pair `least(uuid):greatest(uuid)` behind a partial `UNIQUE` index
  (`where direct_key is not null`). The RPC reads `direct_key` first, takes
  `pg_advisory_xact_lock`, re-reads, and on `unique_violation` re-selects and
  returns the existing row — so the same patient+doctor pair can never
  duplicate, even under a concurrent double-click. Existing direct threads are
  backfilled from their two participants.
- Messages are append-only (no UPDATE/DELETE policies). Membership is tested
  only through `is_conversation_participant(id)` (SECURITY DEFINER, keyed on
  `auth.uid()`); an INSERT requires `sender_id = auth.uid()`. No direct INSERT
  policy exists on `messages` beyond that.
- **UI.** One floating widget (`FloatingChatWidget`, fixed bottom-end,
  `z-index: 50`) owns Inbox (`ChatList`) + New Chat (`SearchUsers`); a thread
  renders inline or on the `#chat/<conversationId>` route (`ChatWindow` +
  `useRealtimeChat`). Dashboard cards open the widget through the
  `caremunicate:open-chat` window event — the widget is the single owner of chat
  state, no surface re-implements creation.
- `SearchUsers` resolves people through the SECURITY DEFINER `search_users()`
  RPC — **never** a direct `profiles` read (profiles RLS stays strict) — matching
  by **email or username**. `search_users` is maintained in Supabase, NOT in this
  repo; its returned shape (`user_id`/`id`, `username`/`email`) is normalized in
  the client so the UI does not depend on exact column names.
- **Failure copy is the RAW database message, inline** (`message (code)`, e.g.
  `column profiles.email does not exist (42703)`) for both the search and the
  pick — never a silent fail, never a bare status code. Implemented by
  `rawErrorText()` in `SearchUsers.tsx`.
- **CF-2 (chat-creation 42703).** `202609250004_chat_creation_repair.sql`.
  Diagnosis: the creation path finds the peer via `search_users()`, which matches
  BY EMAIL (UI copy: "Search any patient or doctor by email"), and the dashboard
  / chat list / calendar / notifications all `select ... email` from `profiles` —
  but no migration ever added that column ⇒ **42703 undefined_column** the moment
  a chat is started. Fix: add `profiles.email` (idempotent), backfill it from
  `auth.users`, keep it populated with the `profiles_fill_email` BEFORE
  INSERT/UPDATE trigger, index `lower(email)`, and add the `direct_key`
  idempotency key above. Ends with `notify pgrst, 'reload schema'`. The code's
  intent (email lives on `profiles`) is authoritative; the column was the gap.
  Founder-run, unverified from the repo.
- **CF-4 — open in the built-in messenger, never a new tab.** A global
  `MessengerProvider` / `useMessenger()` (`src/context/MessengerContext.tsx`,
  mounted in `main.tsx`) owns `open` + `target`. Creating or picking a chat calls
  `openMessenger({ conversationId, peerName, peerRole })` and the floating widget
  opens IN PLACE — the URL does not change and no new tab is spawned
  (grep-proven: zero `window.open` / `target="_blank"` across the chat surfaces).
  The thread header carries peer name + role chip + an **Expand** icon (the ONLY
  route to the full-page `#chat/<id>`, same tab) + a **Close X** (hides the panel,
  keeps the conversation). On `<md` the panel renders as a bottom sheet (70vh,
  rounded top) via `.chat-widget-panel`. Chat relative timestamps use the shared
  locale-aware `relativeTime()` in `lib/time.ts` (no hardcoded "2h"/"just now").
- **CF-6 — the panel header is responsive.** `.chat-widget-panel` is
  `width: min(100vw - 1rem, 380px)`; the thread header (`.chat-thread-header`)
  lets the name truncate (`.chat-thread-name`, `min-width: 0`) while the role
  chip (`.chat-role-badge`, 11px → 10px under 480px) and the action buttons
  (`.chat-thread-actions`) are `flex: 0 0 auto` — so the close X stays fully
  visible at a 320px viewport. The `<md` bottom sheet keeps the header inside
  the safe area (`padding-bottom: env(safe-area-inset-bottom)`).

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

## Scheduling — conflicts, slots, reminders

- `appointments` gained `buffer_minutes` (clearance per side) and `reminder_sent`
  in `202609220001_appointment_scheduling.sql`. `specialty` lives on `profiles`,
  never on `appointments`.
- **Overlap is enforced twice, HALF-OPEN** (CF-7): a client pre-check
  (`findConflict` → `overlapsHalfOpen` in `src/lib/appointments.ts`) that renders
  `cal.slotTaken` — "That slot is already booked." — without a round-trip, AND a
  DB trigger (`guard_appointment_overlap`). Touching intervals coexist: a slot at
  the previous appointment's exact end is FREE. The predicate is strict `<` on
  both sides, never `<=` — in BOTH the client and the trigger
  (`202609250007_half_open_overlap.sql`).
- **Buffer is INERT — it never blocks a booking** (CF-8, supersedes CF-7's
  trailing-buffer behaviour). The `buffer_minutes` columns stay in the schema
  (default 0) for a possible future feature but are NOT read by the overlap
  predicate, never written non-zero, and not surfaced in the UI (the availability
  editor exposes no buffer control; the orange dashed "buffer-blocked" slot style
  and its tooltip are deleted). Overlap is decided by REAL appointment intervals
  only, half-open.
- The guard raises **SQLSTATE `23P01`** (`appointment_overlap`); the client maps
  it to `cal.slotTaken` via `isOverlapError`.
- **CF-9 — the trigger is the ONE server enforcer.** No exclusion constraint
  exists in-repo; `202609250009_server_overlap_half_open.sql` defensively drops
  any stray `EXCLUDE` constraint on `appointments` and (re)asserts
  `guard_appointment_overlap` half-open + buffer-free, so the grid and the server
  can never disagree. `check (end_at > start_at)` is row-validity only, not an
  overlap check.
- **Slots show, not hide**: `slotStatesForDate` returns every slot in the
  weekday rule with `available` + `reason` ('past' | 'busy'); unavailable chips
  render disabled/greyed. `slotsForDate` is just the open subset.
- `provider_busy_slots` returns raw ranges only; the client uses them as-is and
  the DB trigger is the exact backstop.
- **Reminders** run in `supabase/functions/send-reminders` (Deno Edge Function,
  daily): appointments due within 24h with `reminder_sent = false` (status
  `scheduled|confirmed` only) are emailed via **Resend** and the flag flips only
  on a successful send. `RESEND_API_KEY` / `RESEND_FROM` are Supabase function
  secrets — never `VITE_`-prefixed, never in the bundle. `src/lib/reminders.ts`
  builds the payload client-side and does not send.

## Email & 2FA (CR3)

- **Email-code 2FA is first-party**, not Supabase's hosted OTP.
  `request_2fa_code(p_locale)` (SECURITY DEFINER, pg_net → Resend) generates a
  6-digit code, stores only its bcrypt hash in `email_otp_codes(user_id,
  code_hash, expires_at, attempts)` (10-min TTL, 5 attempts, 30s cooldown), and
  emails it from a **jsonb template map covering all 10 locales**. Lookup is
  `COALESCE(map -> locale, map -> 'en')`, so an unknown / NULL / garbage locale
  ALWAYS sends English — never NULL, never a silent abort. The payload is
  `jsonb_build_object(...)`, never string concatenation.
- `verify_2fa_code(p_code)` checks the hash and returns a boolean; on success the
  login flow creates the persistent session by re-running `signInWithPassword`
  (the password already passed the Session Trap) — there is no token to promote.
  Both RPCs are granted to `authenticated` only.
- **Never raise email failures into the UI.** A failed send is written to
  `email_log(email, type, locale, error)` and the function returns `false`; the
  client reads the boolean and shows an inline notice. The locale is passed
  EXPLICITLY from UI state (the language switcher's value), never from a cookie.
- Resend key for the **DB-side** send lives in `private.mail_config(key, value)`
  (rows `resend_api_key`, `resend_from`), read through the LOCKED getter
  `public.mail_secret('resend_api_key')` — SECURITY DEFINER with NO grants, so
  PostgREST / any client role can never call it. Hosted Supabase denies
  `alter database ... set app.*` (42501, postgres is not superuser), which is why
  the old GUC path was dropped (`202609250010`). Separate from the Edge
  Function's `RESEND_API_KEY`.
- **Sibling**: `send-reminders` records failures in the same `email_log`. It is
  English-only because `profiles` carries no locale column.
- **C-04 — mail endgame.** Custom code emails (2FA + any custom OTP) use ONE
  static template (`202609250010_mail_endgame.sql`): a branded card, the code in
  a big mono block, and ALL ten repo locales STACKED in the same email — no
  per-locale template map, no magic links, no dynamic hooks. `email_log` gained
  `to_email/kind/status/resend_id` plus a single `log_email(...)` writer; every
  send logs `sent` (with the pg_net request id) or `failed` (with the raw
  reason). `send_test_email(to)` returns the RAW Resend response for the founder
  (service_role only). One DB-side key read:
  `public.mail_secret('resend_api_key')` over `private.mail_config`; the Edge
  Function runtime keeps its own `RESEND_API_KEY`. A missing or non-`re_` key is
  a CONFIG failure logged loudly. The 6-box `CodePanel` (`src/components/CodePanel.tsx`) is the shared
  verify UI — wired into the 2FA email + authenticator views today; signup
  confirm / recovery / email-change reuse it next.

## Password recovery (CR4)

- Login's "Forgot password?" opens an inline panel (no route change):
  `resetPasswordForEmail(email, { redirectTo: `${origin}/reset-password` })`,
  the raw Supabase error shown inline, and a 60s resend cooldown on success.
- `/reset-password` is a **public** route — never behind `ProtectedRoute`
  (the equivalent of a Next middleware exemption) — detected by
  `isResetPasswordPath()` in `App.tsx` and rendered as the `reset` RouteKey. It
  waits up to 3s for the `detectSessionInUrl` exchange, watching BOTH
  `getSession()` and `onAuthStateChange` (`PASSWORD_RECOVERY` / `SIGNED_IN`) so
  the one-shot read cannot lose the race. No session after 3s → invalid-link
  card → back to `#login`. A session → strength bar + confirm →
  `updateUser({ password })` → success card → `#profile` (the repo's post-auth
  route; the recovery session becomes the real one, no sign-out).
- A failed `updateUser` writes `email_log(type = 'recovery-ui')`. `email_log`
  carries ONE RLS INSERT policy allowing authenticated rows of type
  `recovery-ui` only.

## Care Plans — `#care` + `#patients`

- The dashboard sidebar (`.profile-sidebar`) link opens `#care` for a patient and
  `#patients` for a provider. There is **no left sidebar** — navigation is the
  top bar plus the dashboard's side column.
- `#patients` is the first doctor-facing patient profile: known patients are
  derived from existing appointments + conversations (no assignment table), and
  the detail panel has Overview / Care Plans tabs.
- Tables `care_plans` / `care_plan_tasks` / `care_plan_logs`; creation is the
  atomic `create_care_plan` RPC. One log per `(task_id, log_date)`.
- Task model: `metric_type` (number|boolean) + `frequency` (daily|weekly) + a
  configurable `goal_count`/`goal_unit` (day|week). Compliance reads
  "Task completed X/Y days this week" (or weeks).
- RLS cannot scope a plan to a care team — no provider↔patient assignment model
  exists, so any provider may create a plan for any `patient_id` (the same
  documented trade-off as `emergency_alerts`).

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
