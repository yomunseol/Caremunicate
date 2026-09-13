# Caremunicate — session handoff

Written after commit `f6eeb6d`. Working tree clean. Everything below was verified
against the repo at that commit unless explicitly marked **unverified**.

---

## 1. What this is

A medical-communication web app. React 18 + TypeScript + Vite + Supabase, hash-based
router, mint/green theme, inline styles plus `src/styles/globals.css`.

**No Tailwind.** The stylesheet is plain CSS; components use `styles` objects.

### Non-negotiables (re-stated by the user across many turns)

- **Zero API keys, zero env vars beyond Supabase's own**, no credit cards, no paid services.
- **No new npm dependencies** unless the user names one explicitly.
- **i18n strings are exact.** When the user supplies translations, do not re-translate,
  rephrase, "improve" or machine-translate them. Where a supplied string has a typo it
  has been corrected and flagged (Hebrew `התחברות`, Arabic `المكالمة`) — that pattern was
  accepted, keep using it.
- **10 locales**: `en, fr, es, ko, zh, pt, de, it, ar, he`. `ar` + `he` are RTL.
- **RTL-safe CSS**: logical properties (`padding-inline`, `margin-block`, `text-align: start`).
  Use `[dir='rtl']` overrides only where logical is impossible. Wrap OTP codes / room codes /
  phone numbers in `<span dir="ltr">`.
- **Build must be green before every commit.** `npm run build` = `tsc -b && vite build`.
- Commit messages end with `Co-authored-by: CommandCodeBot <noreply@commandcode.ai>`.

---

## 2. Git state

HEAD `f6eeb6d`, pushed to `origin/main`.

```
f6eeb6d Doctor verification: real badge, schema, and admin guard
dde909b Call rooms: code generator, password hashing, room lifecycle
a5ea3c2 Harden the WebRTC engine: capture/sender caps, adaptive ladder, stats chip
25781fd Replace Jitsi with a first-party WebRTC calling engine
e137a2d Add provider roles, role-aware dashboard cards, and switcher/map fixes
c2fd395 Fix pricing mistakes
d809c2e Replace Nominatim/iframe map with Overpass API + Leaflet
e74c70a Switch pricing lineup to Basic / Plus / Pro / Independent Doctor
```

---

## 3. Migrations

In `supabase/migrations/`, apply order matters:

| File | Covers |
|---|---|
| `202609090001_chat_schema_rls.sql` | `profiles`, conversations, participants, `create_direct_conversation()` |
| `202609120001_add_profiles_plan.sql` | `profiles.plan` |
| `202609150001_plan_lineup.sql` | plan lineup |
| `202609160001_provider_roles.sql` | **widens roles to include `department`** |
| `202609170001_emergency_alerts.sql` | `emergency_alerts` |
| `202609180001_doctor_verification.sql` | verification columns, `is_admin()`, guard trigger, policies |

**Which are applied to the live database is unknown from the repo.** The user applies SQL
themselves via the Supabase SQL editor. Blocker that has been flagged twice and not yet
confirmed as run:

> `202609160001_provider_roles.sql` must be applied **before any Department signup**.
> `conversation_participants.role` otherwise rejects `'department'` and
> `create_direct_conversation()` raises `'invalid role on a profile'`, so a department
> account cannot start a single conversation.

Also note: `call_rooms` and the `check_call_room` RPC are **not** in any migration here.
The user maintains them directly in Supabase.

---

## 4. Code map

```
src/
  App.tsx                    routing, auth screen (signup form is inline here — ~1100 lines)
  i18n.jsx                   LangProvider, useLang(), LOCALES, translations (410 keys x 10)
  lib/
    supabase.ts              client
    roles.ts                 PROVIDER_ROLES, isProvider(), roleLabelKey()
    callRooms.ts             code generator, password hashing, room CRUD/RPC
    conversations.ts         createDirectConversation()
    displayName.ts           resolveDisplayName() — never render an empty name
  hooks/
    useCall.ts               WebRTC: perfect negotiation, mesh <= 4, caps, adaptive ladder
    useRealtimeChat.ts       message subscription
  components/
    DashboardOverview.tsx    left column, role-aware (sticky on desktop)
    CarePlaces.tsx           Overpass + Leaflet place finder (all authenticated users)
    PricingSection.tsx       plan cards
    VerificationBadge.tsx    the ONLY render site of the certified label
    EmergencyCard.tsx        patient SOS card
    EmergencyAlertBanner.tsx provider realtime banner
    CallRoom.tsx             incoming-call modal + in-call overlay
    ChatWindow / ChatList / SearchUsers / FloatingChatWidget
    LanguageSwitcher.tsx     portaled dropdown (see gotcha #5)
    PasswordAuth.tsx / TwoFactorSetup.tsx / ProtectedRoute.tsx / ErrorBoundary.tsx
tests/
  care-places.spec.ts        OBSOLETE — still mocks Nominatim (see gotcha #2)
```

### Conventions that matter

- **`isProvider(role)`** covers `doctor | department | hospital`. Every gate must use it,
  not `role === 'doctor'`. Remaining literal `=== 'doctor'` checks in `App.tsx` are the
  per-role *signup field* branches and are correct as-is.
- **Role labels** always go through `roleLabelKey(role)` → `t(...)`, which falls back to
  `chat.careMember`. Preserve the never-render-empty behaviour.
- **`profiles.verification_status`** gates the certified badge. Nothing else may render it.
- **No plan may require contacting sales.** Every plan is self-serve.

### Current pricing lineup (verified in `PricingSection.tsx`)

| id | price | flags |
|---|---|---|
| `basic` | $9 | |
| `plus` | $29 | `popular: true` |
| `pro` | $49 | |
| `independent-doctor` | $79 | `grantsDoctorRole: true` |
| `department` | $149 | `grantsDoctorRole: true` |

Turn 21 mentioned six plans — **check whether a sixth (hospital) plan is expected.**
Plus and Pro carry emergency-lane support; Plus and Pro both have *priority lane*
(not "priority routing"). Consultations are split into text vs video.

---

## 5. Pending work, in priority order

### 5.1 Finish the call-room system (largest item, explicitly requested)

`src/lib/callRooms.ts` exists (codes, hashing, `createRoom` / `checkRoom` / `setRoomStatus`)
and the 12 `call.*` i18n keys are in all 10 locales. **Not built:**

1. **Signaling rework in `useCall.ts`.** Currently the room id is an arbitrary string on a
   channel named `call:{roomId}` with generic event names. Needs: channel
   `call:{normalizeCode(code)}`, events `call:join` / `call:offer` / `call:answer` /
   `call:ice` / `call:leave` / `call:ended`, broadcasts with `self: false`, host promotion
   on SUBSCRIBED, a `receive('broadcast')` message handler wired to the DataChannel, and
   `openDataChannel(peerId, dc)`.
2. **DataChannel heartbeats + releasing the signaling plane.** Ping every 3s over the data
   channel once it opens, and `removeChannel` the Supabase channel mid-call. This has been
   specified twice and **never shipped**. Blocking design question: who still holds the
   channel if every peer unsubscribes? Releasing it strands late joiners unless the host
   keeps it. Needs a decision before coding.
3. **Host flow UI** — "Start meeting" plus optional password field, showing the generated
   code with copy / share actions.
4. **Join flow UI** — "Join with code", password step driven by `has_password`, and error
   states `roomNotFound` / `wrongPassword`.
5. **`/call/{code}` route** — does not exist. `App.tsx` routes `home | signup | login |
   profile | pricing | chat` only. Needs a route key, hash parsing (strip a leading `/` so
   `#/call/mint-fox` works as well as `#call/mint-fox`), and a wrapper that calls
   `checkRoom` and blocks entry when it fails.
6. **`receive('broadcast', ...)`** with room host auto-promotion on the `call:{code}` channel.

Do not regress the existing call stack: stage UI, capture caps (720p/30fps), sender caps
(`maxBitrate 900000`, `maxFramerate 30`, `degradationPreference: 'balanced'`), H.264
preference with VP8 fallback, 5s `getStats()` adaptive ladder (720→480→360→audio-only),
mesh cap 4, stats chip.

### 5.2 Verification Center and Admin Review Panel

`f6eeb6d` shipped only the badge + schema + i18n half. Still missing:

- Doctor-only card with license number, issuing authority, and a document upload to the
  private `verification-docs` bucket at `{user_id}/license-{timestamp}.pdf`, moving
  `verification_status` to `pending`.
- Admin panel gated on `is_admin`, listing pending doctors with a signed-URL document
  viewer and Approve / Reject-with-note.
- Rejected doctors see the admin's note and can resubmit.

### 5.3 Smaller, already-identified

- **`PricingSection` role metadata is stale.** `signupRole` is typed `'patient' | 'doctor'`
  and `grantsDoctorRole: true` writes role `doctor` — including for the **department** plan,
  which now has its own role. Needs a 4-role type and a `grantsRole` value.
- **Profiles write is skipped on email confirmation.** In `App.tsx` signup, `profiles.role`
  is only upserted when `data.session` exists. Confirmed-by-email signups keep the role in
  metadata only. Fix by reconciling in `DashboardOverview` on first authenticated load.
- **`tests/care-places.spec.ts` will fail.** It mocks `nominatim.openstreetmap.org` and
  asserts a `viewbox` param; the app now POSTs to Overpass and renders Leaflet. Rewrite to
  mock the Overpass POST and assert the `data=` body contains `around:5000`.
- **Duplicate emergency rows (reported earlier, unverified this session).** `EmergencyCard`
  inserts an alert when a line starts, and `useCall` inserts one if an emergency invite goes
  unanswered. Both correct alone, together they can produce two active rows. The user must
  pick one owner.
- **Logical-property sweep unfinished.** Known physical values: `margin-right` in
  `globals.css` (~line 800, ~1119); inline `left:`/`right:` in `SearchUsers.tsx`,
  `CarePlaces.tsx`, `FloatingChatWidget.tsx`. The `ltr` island in the Leaflet wrapper is
  intentional.
- **Unused i18n keys**, kept only because the user said "keep all existing translations
  intact": `dash.certificationVerified` / `dash.certificationPending`, `verify.verified`,
  `profile.emergencyEyebrow/Title/Copy/Button`, `profile.pill1/2/3`, `dash.videoTitle`,
  and six `places.*` (`minChars`, `noFiltered`, `globalSearch`, `openInOsm`, `mapOf`,
  `mapPlaceholder`). Offer to prune; do not delete unilaterally.
- **Dead CSS**: `.role-toggle` / `.role-button` rules survive the removal of the
  Patient/Doctor toggle.

---

## 6. Unverified inferences — confirm before trusting

These are guesses made against schema that is not visible from the repo. Each is a
one-line fix if wrong.

1. **`check_call_room` return shape.** `callRooms.ts` assumes the returned row carries
   `ok`, `has_password`, and optionally `status` / `room_id` / `host_id`, read as
   `data?.[0] ?? null`.
2. **The no-password convention.** `checkRoom` sends `p_password_hash: null` when the user
   typed no password, reasoning that a passwordless room must not be handed a hash. If the
   RPC instead expects `hash(code + '')`, **every passwordless join breaks**. Highest-risk
   line in the file.
3. **`call_rooms` columns**: `code`, `host_id`, `password_hash`, `status`, `ended_at`.
   `createRoom` relies on `code` being UNIQUE (it retries Postgres `23505`, up to 5 times).
4. **`profiles.role` has no CHECK constraint** — nothing in the repo constrains it, but the
   live table is unknown. `conversation_participants.role` definitely did.
5. **Whether the four latest migrations have been applied.**

---

## 7. Gotchas that have already cost time

1. **Leaflet vs. the header.** Leaflet panes use `z-index` 400–1000, and `.topbar` had
   `backdrop-filter`, which makes it a containing block for `position: fixed` children. The
   language menu is therefore portaled to `document.body` with `z-index: 2000`, and
   `.topbar` is `z-index: 1100`. `.topbar` also keeps `position: sticky` (not `relative` as
   one brief literally asked) — changing it breaks header stickiness.
2. **Overpass CORS.** Fetches are routed through `https://corsproxy.io/?...` with an 8s
   `AbortController`, `isLoading` cleared in `finally`, and `console.error('OVERPASS_ERROR:', e)`.
   Nominatim is no longer used anywhere; all `places.*` strings resolve through `t()`.
3. **`.form-row` collapses to one column at ≤720px.** The signup role tiles are a separate
   grid that must stay 2×2 on mobile.
4. **Scratchpad scripts are session-scoped.** The i18n patcher pattern is reproducible from
   the recipe in §8 — do not assume the old scripts still exist.
5. **`App.tsx` is a ~1100-line monolith** with the signup form inline. Extracting
   `SignupForm.tsx` has been offered and never done. If a task touches it heavily, propose
   extraction first.

---

## 8. Verification recipes

```bash
npm run build                 # tsc -b && vite build — must be green before committing
```

i18n completeness (every locale has every `en` key, and no duplicate keys):

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

Runtime test of plain TS with no build step (Node 22, strips types):

```bash
grep -v \"^import { supabase } from './supabase';\" src/lib/callRooms.ts > /tmp/cr.ts
node --experimental-strip-types /tmp/verify.mjs      # imports './cr.ts'
```

Add a new i18n namespace by patching each locale block: locate
`^  (\w+): \{$` markers, insert the new keys before each block's final `\n  },`, then
re-run the completeness check. **Run the check every time** — a missing key silently falls
back to English, which the user notices immediately in `ar` / `he`.

Never edit `.commandcode/taste/**`; use the `taste` tool if a preference needs recording.

---

## 9. Open questions for the user

1. Apply `202609160001_provider_roles.sql` — done or not? Blocks Department accounts.
2. `check_call_room`'s return shape, and does it expect `null` or `hash(code + '')` for
   "no password supplied"?
3. In the DataChannel handoff, who keeps the Supabase channel once the mesh is full?
4. Is a sixth (hospital) pricing plan expected?
5. Which component owns emergency-alert creation — `EmergencyCard` or `useCall`?
6. Independent Doctor at **$79** — the pre-existing repo plan was $69; confirm $79 stands.
