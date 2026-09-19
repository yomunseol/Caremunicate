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
- **Writes go through the `set_own_plan(plan)` RPC only** — never a direct
  client write. After the call the client re-reads `profiles.plan`, so the badge
  updates without a reload.
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
