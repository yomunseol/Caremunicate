# Caremunicate — project handoff & context

> **This is the live context file — read it before touching anything.**
> Rewritten 2026-09-13. The previous revision (written after `f6eeb6d`) is
> superseded: the call system, the code engine, the Overpass proxy and the
> doctor-verification half it listed as "pending" are all built now.
>
> A local copy of this context also lives at `.commandcode/session-context.md`
> (gitignored — it is the agent's working copy of the same material).

---

## 0. Working agreements (READ FIRST)

- **Commit every edit.** Never leave work uncommitted or sitting staged. Commit
  (and push) as part of finishing a change, without being asked each time.
  Recorded in `.commandcode/taste/taste.md` via the `taste` tool.
- **`npm run build` must be green before every commit** (`tsc -b && vite build`).
- Commit messages end with
  `Co-authored-by: CommandCodeBot <noreply@commandcode.ai>`.
- **Never edit `.commandcode/taste/**`.** Read it freely; to record a preference
  use the `taste` tool.
- **Zero API keys, zero env vars beyond Supabase's own**, no paid services.
  **No new npm dependencies** unless the user names one explicitly.
- **i18n strings are exact.** When the user supplies translations, do not
  re-translate, rephrase, "improve" or machine-translate them. Where a supplied
  string carries a typo it has been corrected and flagged (Hebrew `התחברות`,
  Arabic `المكالمة`) — that pattern was accepted, keep using it.
- **10 locales**: `en, fr, es, ko, zh, pt, de, it, ar, he`. `ar` + `he` are RTL.
- **RTL-safe CSS**: logical properties (`padding-inline`, `margin-inline`,
  `inset-inline`, `text-align: start`). `[dir='rtl']` overrides only where
  logical is impossible. Wrap OTP codes / room codes / phone numbers in
  `<span dir="ltr">`.
- **Keep changes surgical** — the user repeatedly asks to touch only the named
  flow.
- **Re-run the i18n completeness check after any dictionary edit.** A missing
  key silently falls back to English, which the user notices in `ar` / `he`.

---

## 1. What this is

A medical-communication SPA: emergency doctor listings, patient / doctor /
department / hospital plans, chat, and a first-party video-calling system.

**Stack:** React 18 + TypeScript + Vite + Supabase (auth, Postgres, Realtime),
Leaflet for the map. **No Tailwind** — `src/styles/globals.css` is plain CSS
with mint tokens (`--accent`, `--accent-strong`, `--accent-soft`, `--line`,
`--shadow`, `--text*`); components add `styles` objects. **No React Router** —
hash + `history.pushState` from `App.tsx`. Deployed on Vercel (`vercel.json`
rewrites everything to `/index.html`, so path-style URLs work).

**Paths:** `src/**` (browser), `server/overpass.ts` (shared proxy core) +
`api/overpass.ts` (Vercel function), `supabase/migrations/`, `tests/`.

**Scripts:** `dev`, `build`, `preview`. No lint script, no unit-test runner.

`src/firebase.ts` is legacy dead code (nothing imports it, `VITE_FIREBASE_*`
unset). `.env.example` documents only the Firebase vars — the app actually needs
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (`src/lib/supabase.ts`).

## 2. Git state

Branch `main`, tree clean, in sync with `origin/main`.

## 3. Migrations

`supabase/migrations/` — apply order matters, and **which are applied to the
live database is unknown from the repo** (the user runs SQL by hand in the
Supabase editor):

| File | Covers |
|---|---|
| `202609090001_chat_schema_rls.sql` | `profiles`, conversations, participants, `create_direct_conversation()` |
| `202609120001_add_profiles_plan.sql` | `profiles.plan` |
| `202609150001_plan_lineup.sql` | plan lineup |
| `202609160001_provider_roles.sql` | widens roles to include `department` |
| `202609170001_emergency_alerts.sql` | `emergency_alerts` |
| `202609180001_doctor_verification.sql` | verification columns, `is_admin()`, guard trigger, policies, `verification-docs` bucket |

> `202609160001_provider_roles.sql` must be applied **before any Department
> signup** — `conversation_participants.role` otherwise rejects `'department'`
> and `create_direct_conversation()` raises `'invalid role on a profile'`, so a
> department account cannot start a single conversation.

**Maintained directly in Supabase, NOT in this repo:** `call_rooms` and the
`check_call_room` RPC. Treat every column as an assumption and degrade
gracefully — the established pattern is to drop the optional field and retry on
`42703` / `PGRST204`.

## 4. Code map

```
src/
  App.tsx                    router + auth screens (signup form inline — ~1.1k lines)
  i18n.jsx                   LangProvider, useLang(), LOCALES, translations
  lib/
    supabase.ts              client
    roles.ts                 PROVIDER_ROLES, isProvider(), roleLabelKey()
    wordBank.ts              WORD_BANK — 1024 curated words, 16 categories x 64
    wordcode.ts              generateWordCode / normalizeCode / isValidWordCode
    callRooms.ts             rooms, resolveRoom, resolveJoin, check/create/update
    callPrefs.ts             profiles.call_prefs + pending-policy stash
    conversations.ts         createDirectConversation()
    displayName.ts           resolveDisplayName() — never render an empty name
  hooks/
    useCall.ts               the whole call store + WebRTC engine
    useActiveSpeaker.ts      VAD for the speaker view
    useRealtimeChat.ts       message subscription
  components/
    CallHub.tsx              THE call entry point (/call)
    CallPage.tsx             /call/<param> route guard
    CallLayer.tsx            THE ONLY call UI (portaled, z-index 3000)
    CallPreJoin.tsx          green room
    CallParticipantsPanel.tsx / CallSettingsModal.tsx / CallOverflowMenu.tsx / CallDevicePicker.tsx
    DashboardOverview.tsx    left column, role-aware (sticky on desktop)
    CarePlaces.tsx           Overpass + Leaflet place finder
    PricingSection.tsx       plan cards (6)
    VerificationBadge.tsx    the ONLY render site of the certified label
    EmergencyCard.tsx        patient SOS card
    EmergencyAlertBanner.tsx provider realtime banner
    ChatWindow / ChatList / SearchUsers / FloatingChatWidget
    LanguageSwitcher.tsx     portaled dropdown (see gotcha 1)
    PasswordAuth.tsx / TwoFactorSetup.tsx / ProtectedRoute.tsx / ErrorBoundary.tsx
server/overpass.ts           mirror rotation + 15s per-mirror abort
api/overpass.ts              Vercel function serving /api/overpass
tests/care-places.spec.ts    OBSOLETE — still mocks Nominatim
```

**Conventions that matter**

- **`isProvider(role)`** covers `doctor | department | hospital`. Every gate must
  use it, not `role === 'doctor'`. The remaining literal `=== 'doctor'` checks in
  `App.tsx` are the per-role *signup field* branches and are correct as-is.
- **Role labels** go through `roleLabelKey(role)` → `t(...)`, falling back to
  `chat.careMember`. Preserve the never-render-empty behaviour.
- **`profiles.verification_status`** gates the certified badge; nothing else may
  render it.
- **No plan may require contacting sales** — every plan is self-serve.
- **The UUID must never render.** Words at the UI edge, `call_rooms.id` in the
  transport, the DB as the only translation layer.

**Pricing lineup (verified, six plans):** `basic` $9 · `plus` $29 (`popular`) ·
`pro` $49 · `independent-doctor` $79 · `department` $149 · `hospital` $399. The
last three set `grantsDoctorRole: true`.

---

## 5. Call system

### Code engine

- `WORD_BANK` — **exactly 1024** curated words, 16 semantic categories × 64
  (animals, birds, plants, trees, weather, water, land, sky, colors, foods,
  spices, materials, tools, music, places, positive traits). 3–8 letters,
  `a–z` only, globally unique. No offensive/slang/medical-emergency terms, no
  homophones of common words.
- `generateWordCode()` — `crypto.getRandomValues`, four **distinct** indices
  without replacement. Nothing is derived from any identifier.
- A **dev-only validator throws at import** if the bank is the wrong length, has
  duplicates, or holds a word outside `/^[a-z]{3,8}$/`, so a bad bank cannot ship.

### Addressability

- Public identifier = the 4-word code. Transport key = `call_rooms.id` (UUID).
  The channel is `call:${room.id}`; no channel is ever keyed by words.
- `resolveRoom(input)` translates either way: a UUID is already a valid key (the
  lookup only recovers the words), a word code must resolve to a UUID or the
  join is refused, synthetic `dm-…` / `em-…` keys pass through. Its row select
  falls back to `id, code` when the optional policy columns are absent.
- `resolveJoin(input, { password, userId })` is the **single** join guard, used
  by both the hub and the route. Refusals: `roomNotFound`, `password`,
  `meetingLocked`, `lineClosed`, `meetingFull`; the host is exempt from their own
  rules. It also returns the lobby flag and a policy seed.
- **Dev guard:** if a UUID ever reaches the code chip,
  `console.error('CODE LEAK: UUID rendered in UI')` and the code is re-resolved.

### One hub, one stage

| Path | Component |
|---|---|
| `/call`, `#call` | `CallHub` — title, provider-only Start meeting + settings modal, join-with-code, personal-line card |
| `/call/<param>` | `CallPage` — the route guard, canonicalises to `/call/<words>` |
| — | `CallLayer` — the only call UI |

`createRoom()` is called from exactly one place. Dashboard cards and the header
nav only link to `/call`; 1:1 calls call `startCall()` directly. The duplicate
entry points (`CallRoomsPanel.tsx`, `PersonalLineCard.tsx`) have been deleted.

**Start flow:** Start meeting awaits the insert fully before navigating, and the
route guard retries a missed resolve **once after 300 ms** — that removed
"Cannot find meeting" for doctors.

### Call UI

Meet×Zoom language: tiles `rounded-2xl`, 10px gaps, soft shadow, `object-contain`
letterbox, name pill bottom-start, a 2px mint speaking ring (an *outline*, so the
tile's inline shadow cannot override it), initials avatar when the camera is off,
150 ms fade-in. Speaker view = main tile + 96px bottom filmstrip; gallery = equal
`ceil(sqrt(n))` grid; the toggle lives in the overflow menu.

- **Top bar:** code chip (click = copy, `title` = full code, single line) → share
  icon → timer on the left; people chip + gear on the right. Auto-hides with the
  control bar after 3s idle.
- **Control bar:** one centred pill — media (mic, cam, share) · engage
  (reactions, hand) · info (people count, ⋮) — then a separated red leave pill.
  Shortcuts: Alt+M / Alt+V / Alt+S / F.
- **Overflow ⋮:** view toggle, fullscreen, device settings, call stats, and the
  host-only "Host controls" (waiting room, lock/unlock, set new password, remove
  participant list). **No host/security control sits on the main bar.**
- Media: `pc.ontrack` accumulates inbound tracks into a stream we own; local
  tracks go in via explicit `sendrecv` transceivers **before** the first offer;
  caps 720p / 30fps / 900 kbps with an adaptive 720→480→360→audio ladder; H.264
  with VP8 fallback; mesh cap 4; emergency kind preserved.

### State & policy

One store: `useCall()` via `CallProvider` (`src/context/CallContext.tsx`), which
also renders `<CallLayer />`. Policy is broadcast as `call:policy` with
`has_password` as a **boolean** — never a digest. The host turns away locked or
full joiners with `call:kick`; the waiting room uses `call:lobby` / `call:admit`
/ `call:deny`.

---

## 6. Auth architecture

### Supabase JS v2.114 constraints (verified against installed source)

- **No per-call `persistSession` option** — client-construction only.
- `signInWithPassword`, `verifyOtp`, `mfa.challengeAndVerify`, `mfa.verify` all
  internally `_saveSession()` and emit `SIGNED_IN` / `MFA_CHALLENGE_VERIFIED` —
  you cannot "verify without persisting" on a persistent client.
- `mfa.verify` has no `verify: true` flag in this version; use
  `mfa.challengeAndVerify({ factorId, code })`, which returns
  `access_token` / `refresh_token` and persists on the client it runs on.

### The Session Trap flow (`PasswordAuth.tsx`)

1. **Password step:** sign in via `supabaseMemory` (`persistSession:false`,
   `autoRefreshToken:false`). Logs `Password verified, session NOT persisted`.
   Fetch `preferred_2fa_method` from `profiles` via the memory client.
2. **Branch A (`none`):** real `signInWithPassword` on the persistent client →
   `goToProfile()`.
3. **Branch B (`app`):** memory-client `mfa.listFactors()` → hold `factorId` →
   `app_code` view → `challengeAndVerify` → promote with
   `supabase.auth.setSession(...)` → clear pending → hard redirect `/#profile`.
4. **Branch C (`email`):** memory-client `signInWithOtp` → `email_code` view →
   `verifyOtp({ email, token, type:'email' })` → `setSession(...)` → clear
   pending → hard redirect.
5. Verify handlers wrap in `try/catch/finally`; `setLoading(false)` in `finally`
   so the button never sticks on 'Verifying…'.

**Gating:** the pending flag lives in `sessionStorage`
(`caremunicate:pending2fa`); `AuthContext` reports `effectiveSession = pending2FA
? null : session` and auto-clears on `SIGNED_IN` / `MFA_CHALLENGE_VERIFIED` /
`TOKEN_REFRESHED` (with a session) and on `SIGNED_OUT`. `App.tsx` derives
`currentUser` the same way, blocks `navigate('profile' | 'chat' | 'call')` while
pending, and logs out through the context.

**Sign-up validation (in `App.tsx`):** fullName, email, role-specific fields
(doctor / department / hospital), password + confirm; live ✅/❌ password
checklist (min 8, upper, lower, digit, special `!@#$%^&*`), submit disabled until
valid, per-field errors only after blur/submit, passwords cleared in the submit
`finally`. 2×2 role tiles: patient / doctor / department / hospital.

---

## 7. Known decisions / trade-offs (respect these)

- **Frontend-only 2FA enforcement (the user's explicit choice).** It prevents a
  persistent pre-2FA session and a logged-in UI, but is **not** a security
  boundary — a determined user can call Supabase directly with an in-memory
  token. Real enforcement needs RLS + `aal` claims server-side. Explain this
  rather than implying the frontend blocks the account.
- **Console logs are intentional** (the user debugs in F12). Keep the requested
  log strings intact.
- **The call system is client-enforced.** Lobby, lock and capacity are signalled
  client-side, `call:kick` is advisory, and true capacity enforcement belongs in
  the RPC.
- **Meeting rooms** draw a fresh random code per creation (≤10 retries on a
  unique `23505`); **personal rooms** draw one at first creation and keep it
  forever.
- The dashboard target is `#profile` (there is no `/dashboard` route).

## 8. Gotchas that have already cost time

1. **Leaflet vs. the header.** Leaflet panes use `z-index` 400–1000, and
   `.topbar` had `backdrop-filter`, which makes it a containing block for
   `position: fixed` children. The language menu is therefore portaled to
   `document.body` with `z-index: 2000`, and `.topbar` is `z-index: 1100` and
   `position: sticky` — changing that breaks header stickiness.
2. **Overpass is now same-origin.** The browser calls `/api/overpass` only; the
   server rotates mirrors with a 15s abort each and caches. `corsproxy.io` and
   the allorigins path are gone from client code. Results are cached in
   `localStorage` for 10 minutes.
3. **`.form-row` collapses to one column at ≤720px.** The signup role tiles are a
   separate grid that must stay 2×2 on mobile.
4. **Scratchpad scripts are session-scoped.** The i18n patcher pattern is
   reproducible from §9 — do not assume the old scripts still exist.
5. **`App.tsx` is a ~1.1k-line monolith** with the signup form inline.
   Extracting `SignupForm.tsx` has been offered and never done; propose it before
   a heavy edit there.
6. **`vite.config.ts` emits nothing now.** `tsconfig.node.json` sets `noEmit`,
   so Vite resolves the `.ts` config (a stale emitted `vite.config.js` would
   otherwise shadow it).

## 9. Verification recipes

```bash
npm run build                 # tsc -b && vite build — green before committing
```

i18n completeness (every locale has every `en` key, no duplicate keys):

```bash
node -e "
const fs=require('fs');const s=fs.readFileSync('src/i18n.jsx','utf8');
const body=s.slice(s.indexOf('const translations = {'), s.indexOf('\n};\n\nconst supportedLocales'));
const marks=[...body.matchAll(/^  (\w+): \{/gm)].map(m=>({code:m[1],at:m.index}));
const en=new Set([...body.slice(marks[0].at,marks[1].at).matchAll(/'([^']+)':/g)].map(m=>m[1]));
let bad=0;
for(let i=0;i<marks.length;i++){const seg=body.slice(marks[i].at,i+1<marks.length?marks[i+1].at:body.length);const all=[...seg.matchAll(/'([^']+)':/g)].map(m=>m[1]);const k=new Set(all);if(all.length!==k.size)console.log(marks[i].code,'DUPLICATE KEYS');const miss=[...en].filter(x=>!k.has(x));if(miss.length){bad++;console.log(marks[i].code,'MISSING',miss.join(','));}}
console.log('en keys:',en.size,'|',bad?'INCOMPLETE':'all 10 locales complete');
"
```

Runtime-test plain TS with no build step (Node 22 strips types). The resolver
needs explicit `.ts` extensions in Node, so test against patched copies in the
scratchpad rather than importing `src/` directly:

```bash
node --experimental-strip-types <script>.mjs   # import './wordcode.ts', not './wordcode'
```

Add i18n keys by patching each locale block: locate the `^  (\w+): \{$` markers,
insert before each block's final `\n  },`, then **re-run the completeness check**.

Never edit `.commandcode/taste/**`; use the `taste` tool.

## 10. Open items

- **`check_call_room` must accept `(p_input, hash)`** and take a word code *or* a
  UUID. `checkRoom()` still falls back to the legacy `(p_code, p_password_hash)`
  signature, but the digest basis differs for a UUID input, so password-protected
  rooms joined *by UUID* fail until the RPC is migrated.
- **`personal` column required** for personal lines; without it
  `ensurePersonalRoom` returns null and the hub card stays hidden.
- **Waiting room only enforced when the RPC echoes `lobby_enabled`.**
- **Hardcoded English remains** for the mic/camera/reactions/fullscreen/settings
  labels, "Call stats", "Fullscreen", "More", "Encrypted", the kicked toast, and
  "Video unavailable — audio only". Supply the 10-language strings to wire them.
- **`tests/care-places.spec.ts` is obsolete** — it mocks Nominatim and asserts a
  `viewbox`, while the app POSTs to Overpass via `/api/overpass` and renders
  Leaflet.
- **Verification Center is half-built**: the badge + schema + i18n exist; the
  doctor license-card + upload and the admin review panel do not.
- **`PricingSection` role metadata is stale** — `signupRole` is typed
  `'patient' | 'doctor'` and `grantsDoctorRole` writes role `doctor`, including
  for the `department` and `hospital` plans which have their own roles.
- **Profiles write is skipped on email confirmation** — `App.tsx` signup only
  upserts `profiles.role` when `data.session` exists, so confirmed-by-email
  signups keep the role in metadata only.
- **Duplicate emergency rows (reported, unverified).** `EmergencyCard` inserts an
  alert when a line starts and `useCall` inserts one if an emergency invite goes
  unanswered; together they can produce two active rows. One owner needed.
- **Logical-property sweep unfinished** — physical `margin-right`/`text-align:
  left` survive in `globals.css`, and inline `left:`/`right:` in `SearchUsers`,
  `FloatingChatWidget`, `LanguageSwitcher`. The `ltr` island in the Leaflet
  wrapper is intentional.
- **Unused i18n keys** kept only because the user said "keep all existing
  translations intact": `dash.certificationVerified` / `dash.certificationPending`,
  `verify.verified`, `profile.emergency*`, `profile.pill1/2/3`, `dash.videoTitle`,
  `dash.videoHint`, `emergency.end`, and six `places.*` (`minChars`, `noFiltered`,
  `globalSearch`, `openInOsm`, `mapOf`, `mapPlaceholder`). Offer to prune; do not
  delete unilaterally.
- **Dead CSS**: `.role-toggle` / `.role-button` rules survive the removal of the
  Patient/Doctor toggle.
- **Open questions**: has `202609160001_provider_roles.sql` been applied (blocks
  Department accounts)? Which component owns emergency-alert creation?
