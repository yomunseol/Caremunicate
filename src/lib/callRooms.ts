import { supabase } from './supabase';
import { generateWordCode, isValidWordCode, normalizeCode } from './wordcode';

// ---------------------------------------------------------------------------
// Call rooms.
//
// TRANSPORT addresses a room by its call_rooms UUID; the four-word code is the
// PUBLIC identifier shown to people. The database is the translation layer —
// words go in at the UI edge, a UUID comes out, and every channel is keyed by
// that UUID. See lib/wordcode.ts.
//
// Passwords never leave the client in plaintext: only the SHA-256 of
// `${normalizedCode}${password}` is sent to Supabase, so the stored value cannot
// be replayed against another room and the raw password is never persisted.
//
// NOTE: `call_rooms` and the `check_call_room` RPC are managed directly in
// Supabase, not by a migration in this repo. Column names below follow the
// fields named in the spec (code / host_id / password_hash / status / ended_at).
// ---------------------------------------------------------------------------

export { WORD_BANK } from './wordBank';

/** How many times a fresh code is drawn before giving up on a unique insert. */
const COLLISION_RETRIES = 10;

export type CallRoom = {
  id?: string;
  code: string;
  host_id?: string;
  status?: string;
  password_hash?: string | null;
  created_at?: string;
  ended_at?: string | null;
};

export type CheckRoomResult = {
  /** The supplied password (or none) satisfied the room. */
  ok: boolean;
  /** The room exists but is password-protected. Drives the password field. */
  has_password: boolean;
  status?: string;
  room_id?: string;
  host_id?: string;
  /** True when the room holds guests in a waiting room. Optional in the RPC. */
  lobby_enabled?: boolean | null;
  locked?: boolean | null;
  auto_mute?: boolean | null;
  allow_share?: boolean | null;
  max_participants?: number | null;
  /** True when the row is somebody's personal line rather than a meeting. */
  personal?: boolean | null;
  /** Live headcount, so the guard can refuse an over-capacity join. */
  participant_count?: number | null;
};

/**
 * Live room policy, broadcast as `call:policy` and mirrored into `call_rooms`.
 *
 * `has_password` is a BOOLEAN: the password hash never leaves the database and
 * is never put in this object, broadcast, or rendered.
 */
export type CallPolicy = {
  lobby_enabled: boolean;
  locked: boolean;
  auto_mute: boolean;
  allow_share: boolean;
  max_participants: number;
  has_password: boolean;
};

export const DEFAULT_POLICY: CallPolicy = {
  lobby_enabled: true,
  locked: false,
  auto_mute: false,
  allow_share: true,
  // Aligns with the mesh cap the engine enforces.
  max_participants: 4,
  has_password: false,
};

/**
 * Canonical UUID. `call_rooms.id` is internal-only: it must never reach a URL,
 * a channel name, or the UI. This pattern is how we catch it trying to.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const looksLikeUuid = (value: string | null | undefined): boolean =>
  UUID_PATTERN.test((value ?? '').trim());

/** A resolved room: the transport key plus the public identity for the UI. */
export type RoomResolution = {
  /** Transport key — the call_rooms UUID, or a synthetic dm-/em- key. */
  key: string;
  /** Public 4-word code. Empty for synthetic rooms, which have no row. */
  code: string;
  personal: boolean;
  status: string | null;
  host_id: string | null;
};

const SYNTHETIC_RESOLUTION = { personal: false, status: null, host_id: null } as const;

/**
 * Translates any room identifier into its transport key.
 *
 *   UUID input     -> the UUID is already a valid key; the lookup only recovers
 *                     the words so the UI can show them.
 *   word-code input-> the DB is the ONLY route to the UUID. If no row answers,
 *                     `key` comes back empty and the caller must refuse the
 *                     join — a channel keyed by words must never exist.
 *   anything else  -> a synthetic peer/emergency room, passed through.
 */
export const resolveRoom = async (input: string): Promise<RoomResolution> => {
  const value = normalizeCode(input);
  if (!value) return { key: '', code: '', ...SYNTHETIC_RESOLUTION };

  const byId = looksLikeUuid(value);

  // Synthetic peer (dm-<uuid>-<uuid>) and emergency (em-<uuid>) rooms have no
  // call_rooms row and are already valid channel keys.
  if (!byId && !isValidWordCode(value)) {
    return { key: value, code: '', ...SYNTHETIC_RESOLUTION };
  }

  // The policy columns are optional in this project, so a select that names a
  // missing one must not sink the whole lookup — fall back to the core pair.
  const full = await supabase
    .from('call_rooms')
    .select('id, code, personal, status, host_id')
    .eq(byId ? 'id' : 'code', value)
    .maybeSingle();

  let data: unknown = full.data;
  let error = full.error;

  if (error && (error.code === '42703' || error.code === 'PGRST204')) {
    const minimal = await supabase
      .from('call_rooms')
      .select('id, code')
      .eq(byId ? 'id' : 'code', value)
      .maybeSingle();
    data = minimal.data;
    error = minimal.error;
  }

  if (error) console.error('CALL ERROR:', error.message);

  const row = (error ? null : data) as {
    id?: string;
    code?: string;
    personal?: boolean;
    status?: string;
    host_id?: string;
  } | null;

  if (!row) {
    // A UUID still works as a key; a bare word code does not (we must never
    // subscribe on a word-keyed channel).
    return { key: byId ? value : '', code: byId ? '' : value, ...SYNTHETIC_RESOLUTION };
  }

  return {
    key: String(row.id ?? (byId ? value : '')),
    code: String(row.code ?? ''),
    personal: row.personal === true,
    status: typeof row.status === 'string' ? row.status : null,
    host_id: typeof row.host_id === 'string' ? row.host_id : null,
  };
};

// generateWordCode / normalizeCode / isValidWordCode all live in lib/wordcode.ts
// alongside the WORD_BANK they are built from.

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/** SHA-256 hex of `${code}${password}`. The only form of a password that leaves the client. */
export const hashCallPassword = async (code: string, password: string): Promise<string> => {
  const payload = `${normalizeCode(code)}${password ?? ''}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return toHex(digest);
};

/**
 * Creates a room hosted by the current session. Retries on unique-code
 * collisions (Postgres 23505) — 16.7M codes make that vanishingly rare, but a
 * collision must never surface as a failed "Start meeting".
 */
export type CreateRoomOptions = {
  /** Optional room password. Only its SHA-256 ever leaves the client. */
  password?: string;
  lobbyEnabled?: boolean;
  autoMute?: boolean;
  allowShare?: boolean;
  maxParticipants?: number;
};

export type CreatedRoom = {
  /** Transport key — call_rooms.id. */
  id: string;
  /** Public 4-word code. */
  code: string;
};

export const createRoom = async (options: CreateRoomOptions = {}): Promise<CreatedRoom> => {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;

  const hostId = sessionData.session?.user?.id;
  if (!hostId) throw new Error('createRoom requires an authenticated session');

  const trimmed = (options.password ?? '').trim();

  const policyColumns = {
    lobby_enabled: options.lobbyEnabled ?? true,
    locked: false,
    auto_mute: options.autoMute ?? false,
    allow_share: options.allowShare ?? true,
    max_participants: options.maxParticipants ?? DEFAULT_POLICY.max_participants,
  };

  // Field groups, richest first. If this project predates a policy column the
  // insert is retried with a smaller shape instead of blocking "Start meeting".
  const shapes: Array<Record<string, unknown>> = [
    policyColumns,
    { lobby_enabled: policyColumns.lobby_enabled },
    {},
  ];

  let lastError: unknown = null;

  for (const shape of shapes) {
    // A meeting room gets a FRESH random code every time; a unique collision
    // simply draws another one (up to COLLISION_RETRIES times).
    for (let attempt = 0; attempt < COLLISION_RETRIES; attempt += 1) {
      const code = generateWordCode();

      const { data, error } = await supabase
        .from('call_rooms')
        .insert({
          code,
          host_id: hostId,
          status: 'waiting',
          // Only the digest is written; the plaintext password is dropped here.
          password_hash: trimmed ? await hashCallPassword(code, trimmed) : null,
          ...shape,
        })
        .select('id, code')
        .single();

      if (!error) {
        const row = data as { id?: string; code?: string } | null;
        return { id: String(row?.id ?? ''), code: String(row?.code ?? code) };
      }

      // 42703 = undefined_column, PGRST204 = column not found in the schema cache.
      if (error.code === '42703' || error.code === 'PGRST204') {
        lastError = error;
        break; // fall through to the next, smaller shape
      }

      lastError = error;
      if (error.code !== '23505') throw error;
    }
  }

  throw lastError ?? new Error('Could not allocate a unique room code');
};

/**
 * Mirrors a policy change into the room row. Addressed by the transport key
 * (the UUID); never writes `has_password`.
 */
export const updateRoomPolicy = async (roomKey: string, patch: Partial<CallPolicy>): Promise<void> => {
  if (!roomKey) return;

  const columns: Record<string, unknown> = {};
  if (typeof patch.lobby_enabled === 'boolean') columns.lobby_enabled = patch.lobby_enabled;
  if (typeof patch.locked === 'boolean') columns.locked = patch.locked;
  if (typeof patch.auto_mute === 'boolean') columns.auto_mute = patch.auto_mute;
  if (typeof patch.allow_share === 'boolean') columns.allow_share = patch.allow_share;
  if (typeof patch.max_participants === 'number') columns.max_participants = patch.max_participants;
  if (Object.keys(columns).length === 0) return;

  const { error } = await supabase.from('call_rooms').update(columns).eq('id', roomKey);
  // A project without the policy columns simply keeps them in memory only.
  if (error && error.code !== '42703' && error.code !== 'PGRST204') throw error;
};

/**
 * Sets (or clears) the room password.
 *
 * The digest is derived from the PUBLIC code (that is what check_call_room
 * hashes against), written against the room's UUID, and then discarded — it is
 * never returned, stored in state, logged, or broadcast.
 */
export const setRoomPassword = async (
  roomKey: string,
  code: string,
  password: string,
): Promise<void> => {
  if (!roomKey) return;

  const normalizedCode = normalizeCode(code);
  const trimmed = (password ?? '').trim();

  const { error } = await supabase
    .from('call_rooms')
    .update({
      password_hash:
        trimmed && normalizedCode ? await hashCallPassword(normalizedCode, trimmed) : null,
    })
    .eq('id', roomKey);

  if (error) throw error;
};

/**
 * The one gate into a room, shared by the hub's join box and the /call/<param>
 * route guard.
 *
 * `check_call_room(p_input, hash)` accepts EITHER a word code or a UUID. The
 * password digest is always derived from the room's public CODE (that is what
 * the RPC hashes against), so a UUID input is resolved to its code first.
 */
export const checkRoom = async (input: string, password = ''): Promise<CheckRoomResult | null> => {
  const value = normalizeCode(input);
  if (!value) return null;

  // Resolve first only to learn the code the digest must be based on.
  const resolution = await resolveRoom(value);
  const code = resolution.code || value;
  const hash = password ? await hashCallPassword(code, password) : null;

  const call = (params: Record<string, unknown>) => supabase.rpc('check_call_room', params);

  let { data, error } = await call({ p_input: value, hash });

  // Legacy signature: a project that still exposes check_call_room(p_code,
  // p_password_hash). Keeps joins working until the RPC is migrated.
  if (error && (error.code === 'PGRST202' || error.code === '42883')) {
    ({ data, error } = await call({ p_code: code, p_password_hash: hash }));
  }

  if (error) throw error;
  return ((data as CheckRoomResult[] | null)?.[0] ?? null) as CheckRoomResult | null;
};

/** Why a join was refused, in the order the guard checks. */
export type JoinRefusal =
  | 'roomNotFound'
  | 'meetingLocked'
  | 'lineClosed'
  | 'meetingFull'
  | 'password';

export type JoinVerdict =
  | {
      ok: true;
      code: string;
      key: string;
      isHost: boolean;
      personal: boolean;
      /** Waiting room in force for this join. */
      lobby: boolean;
      /** Policy seed for the store, read from the same check_call_room call. */
      policy: Partial<CallPolicy>;
    }
  | { ok: false; reason: JoinRefusal };

/**
 * The single join guard. Both entry points call exactly this, so the hub and
 * the /call/<param> route can never disagree about why a room is closed.
 */
export const resolveJoin = async (
  input: string,
  options: { password?: string; userId?: string | null } = {},
): Promise<JoinVerdict> => {
  const value = normalizeCode(input);
  if (!value) return { ok: false, reason: 'roomNotFound' };

  const result = await checkRoom(value, options.password ?? '');
  if (!result || result.status === 'ended') return { ok: false, reason: 'roomNotFound' };

  // A protected room asks for the password before anything else.
  if (result.has_password && !result.ok) return { ok: false, reason: 'password' };

  const resolution = await resolveRoom(value);
  if (!resolution.key) return { ok: false, reason: 'roomNotFound' };

  const isHost = Boolean(
    options.userId && (result.host_id ?? resolution.host_id) === options.userId,
  );
  const personal = result.personal === true || resolution.personal;
  const status = result.status ?? resolution.status;

  // The host is never blocked by their own room's rules.
  if (!isHost) {
    if (result.locked === true) return { ok: false, reason: 'meetingLocked' };
    if (personal && status === 'waiting') return { ok: false, reason: 'lineClosed' };
    if (
      typeof result.max_participants === 'number' &&
      typeof result.participant_count === 'number' &&
      result.participant_count >= result.max_participants
    ) {
      return { ok: false, reason: 'meetingFull' };
    }
  }

  const policy: Partial<CallPolicy> = {
    lobby_enabled: result.lobby_enabled === true,
    locked: result.locked === true,
    auto_mute: result.auto_mute === true,
    allow_share: result.allow_share !== false,
    has_password: Boolean(result.has_password),
    ...(typeof result.max_participants === 'number'
      ? { max_participants: result.max_participants }
      : {}),
  };

  // Word-code URLs only: never navigate with a UUID.
  return {
    ok: true,
    code: resolution.code || value,
    key: resolution.key,
    isHost,
    personal,
    lobby: result.lobby_enabled === true,
    policy,
  };
};

/** Updates a room's lifecycle status, addressed by its transport key (UUID). */
export const setRoomStatus = async (roomKey: string, status: string): Promise<void> => {
  if (!roomKey) return;

  const patch: { status: string; ended_at?: string } = { status };
  if (status === 'ended') patch.ended_at = new Date().toISOString();

  const { error } = await supabase.from('call_rooms').update(patch).eq('id', roomKey);
  if (error) throw error;
};

// ---------------------------------------------------------------------------
// Personal rooms — one per user, created lazily.
//
// The code is derived from the owner's user id, so it is stable without a
// lookup. A unique collision on insert retries with the NEXT four hash bytes,
// which keeps the mapping deterministic per room.
// ---------------------------------------------------------------------------

export type PersonalRoom = { id: string; code: string; status: string };

/** Finds (or lazily creates) the signed-in user's personal room. */
export const ensurePersonalRoom = async (userId: string): Promise<PersonalRoom | null> => {
  if (!userId) return null;

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    console.error('CALL ERROR:', sessionError.message);
    return null;
  }

  const owner = sessionData.session?.user?.id ?? userId;
  if (!owner) return null;

  const shape = (row: { id?: unknown; code?: unknown; status?: unknown }): PersonalRoom => ({
    id: String(row.id ?? ''),
    code: String(row.code ?? ''),
    status: String(row.status ?? 'waiting'),
  });

  // Already provisioned?
  const { data: existing, error: findError } = await supabase
    .from('call_rooms')
    .select('id, code, status')
    .eq('host_id', owner)
    .eq('personal', true)
    .maybeSingle();

  if (!findError && existing) return shape(existing as Record<string, unknown>);

  // The code is drawn ONCE, at first creation, and then lives in that row
  // forever — the same user always returns to the same code across refreshes,
  // and no two users share one. Only a unique collision draws a new code.
  for (let attempt = 0; attempt < COLLISION_RETRIES; attempt += 1) {
    const code = generateWordCode();

    const { data, error } = await supabase
      .from('call_rooms')
      .insert({
        code,
        host_id: owner,
        status: 'waiting',
        personal: true,
        // Personal rooms default to no lobby and no password.
        lobby_enabled: false,
        password_hash: null,
      })
      .select('id, code, status')
      .single();

    if (!error && data) return shape(data as Record<string, unknown>);

    if (error && error.code !== '23505') {
      console.error('CALL ERROR:', error.message);
      return null;
    }
    // 23505 -> draw another code.
  }

  return null;
};

/** Opens ('active') or closes ('waiting') a personal line. */
export const setPersonalRoomStatus = async (
  roomKey: string,
  status: 'active' | 'waiting',
): Promise<void> => {
  if (!roomKey) return;
  const { error } = await supabase.from('call_rooms').update({ status }).eq('id', roomKey);
  if (error) throw error;
};
