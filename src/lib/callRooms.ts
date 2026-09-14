import { supabase } from './supabase';
import { generateWordCode, isValidWordCode, normalizeCode } from './wordcode';

// ---------------------------------------------------------------------------
// Call rooms — MERGED, not replaced.
//
// The spec's six functions define the behaviour; the names already imported
// across the app define the surface. Each of the six is implemented to the
// spec, and the extra symbols this app already consumes are kept as thin
// wrappers or constants on top of them.
//
//   SPEC, implemented verbatim in behaviour
//     normalizeCode        trim, lower, spaces/underscores -> dashes, collapse
//     hashCallPassword     SHA-256 hex of code + password
//     generateWordCode     crypto.getRandomValues, 4 distinct words, 1024 bank
//     createRoom(opts)     <=10 retries on 23505, returns { id, code }
//     checkRoom(input,pw)  rpc(p_input, p_password_hash), throws, returns the row
//     setRoomStatus(code)  status (+ ended_at when 'ended')
//
//   SURFACE, kept so nothing breaks
//     looksLikeUuid  CallPolicy  DEFAULT_POLICY  CheckRoomResult  CreatedRoom
//     RoomResolution  JoinRefusal  JoinVerdict  PersonalRoom
//     resolveRoom  resolveJoin  setRoomPassword  updateRoomPolicy
//     ensurePersonalRoom  setPersonalRoomStatus
//
// Room ids for channels: a host takes createRoom().id, a joiner takes
// checkRoom().room_id. The signaling channel is call:${id} everywhere and the
// four-word code only ever appears in the UI and in URLs.
// ---------------------------------------------------------------------------

export { normalizeCode };
export { generateWordCode };

/**
 * Canonical UUID. `call_rooms.id` is internal-only: it must never reach a URL,
 * a channel name, or the UI. This pattern is how we catch it trying to.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const looksLikeUuid = (value: string | null | undefined): boolean =>
  UUID_PATTERN.test((value ?? '').trim());

/** SHA-256 hex of `${code}${password}`. The only form of a password we send. */
export async function hashCallPassword(code: string, password: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalizeCode(code) + (password ?? '')),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// The row check_call_room answers with.
// ---------------------------------------------------------------------------

export type CheckRoomResult = {
  /** The supplied password (or none) satisfied the room. */
  ok: boolean;
  /** The room exists but is password-protected. Drives the password field. */
  has_password: boolean;
  status?: string | null;
  /** Transport key for the channel — call_rooms.id. */
  room_id?: string | null;
  /** Public word code. */
  code?: string | null;
  host_id?: string | null;
  /** True when the row is somebody's personal line rather than a meeting. */
  personal?: boolean | null;
  lobby_enabled?: boolean | null;
  locked?: boolean | null;
  auto_mute?: boolean | null;
  allow_share?: boolean | null;
  max_participants?: number | null;
  /** Live headcount, so the guard can refuse an over-capacity join. */
  participant_count?: number | null;
};

/**
 * Live room policy, broadcast as `call:policy` and mirrored into `call_rooms`.
 * `has_password` is a BOOLEAN: no digest ever enters this object.
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
  max_participants: 4,
  has_password: false,
};

export type CreatedRoom = {
  /** Transport key — call_rooms.id. */
  id: string;
  /** Public 4-word code. */
  code: string;
};

export type CreateRoomOptions = {
  /** Optional room password. Only its SHA-256 ever leaves the client. */
  password?: string;
  /** Spec name for the waiting room. */
  lobby?: boolean;
  /** Kept: CallHub already passes this name. */
  lobbyEnabled?: boolean;
  allowShare?: boolean;
  autoMute?: boolean;
};

/** How many fresh codes are drawn before a unique insert is given up on. */
const COLLISION_RETRIES = 10;

/**
 * Creates a meeting room with a FRESH random code, awaiting the insert fully.
 *
 * `status: 'waiting'` is set even though the spec snippet omits it — SECTION 3
 * requires the host to promote the row out of 'waiting' on subscribe, which
 * cannot fire on a null status.
 */
export async function createRoom(options: CreateRoomOptions = {}): Promise<CreatedRoom> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('NOT_AUTHENTICATED');

  const password = (options.password ?? '').trim();
  const lobby = options.lobby ?? options.lobbyEnabled ?? true;

  let lastErr: unknown = null;
  for (let i = 0; i < COLLISION_RETRIES; i++) {
    const code = generateWordCode();

    const { data, error } = await supabase
      .from('call_rooms')
      .insert({
        host_id: user.id,
        code,
        status: 'waiting',
        password_hash: password ? await hashCallPassword(code, password) : null,
        lobby_enabled: lobby,
        allow_share: options.allowShare ?? true,
        auto_mute: options.autoMute ?? true,
      })
      .select('id, code')
      .single();

    if (!error) {
      const row = data as { id?: string; code?: string } | null;
      return { id: String(row?.id ?? ''), code: String(row?.code ?? code) };
    }

    lastErr = error;
    if (error.code !== '23505') break;
  }

  throw lastErr ?? new Error('CODE_COLLISION');
}

/**
 * The one gate into a room.
 *
 * `check_call_room(p_input, p_password_hash)` accepts a word code OR a UUID and
 * answers with the row (room_id, code, status, host_id, personal, has_password,
 * locked, ok). An rpc error is THROWN, never swallowed — the route guard shows
 * the real message rather than pretending the room does not exist.
 */
export async function checkRoom(
  input: string,
  password = '',
): Promise<CheckRoomResult | null> {
  const normalized = normalizeCode(input);
  if (!normalized) return null;

  const hash = password ? await hashCallPassword(normalized, password) : '';

  const { data, error } = await supabase.rpc('check_call_room', {
    p_input: normalized,
    p_password_hash: hash,
  });

  if (error) throw error;
  return ((data as CheckRoomResult[] | null)?.[0] ?? null) as CheckRoomResult | null;
}

// ---------------------------------------------------------------------------
// Surface kept for the rest of the app.
// ---------------------------------------------------------------------------

/** A resolved room: the transport key plus the public identity for the UI. */
export type RoomResolution = {
  /** Transport key — call_rooms.id, or a synthetic dm-/em- key. */
  key: string;
  /** Public 4-word code. Empty for synthetic rooms, which have no row. */
  code: string;
  personal: boolean;
  status: string | null;
  host_id: string | null;
};

const SYNTHETIC_RESOLUTION = { personal: false, status: null, host_id: null } as const;

/**
 * Wrapper over checkRoom, kept for its existing callers (CallLayer's leak
 * guard, CallPage's canonicalisation). Synthetic peer/emergency keys pass
 * through untouched; a word code must answer with a room_id or it is refused,
 * because a word-keyed channel must never exist.
 */
export const resolveRoom = async (input: string): Promise<RoomResolution> => {
  const value = normalizeCode(input);
  if (!value) return { key: '', code: '', ...SYNTHETIC_RESOLUTION };

  // Synthetic peer (dm-<uuid>-<uuid>) and emergency (em-<uuid>) rooms have no
  // call_rooms row and are already valid channel keys.
  if (!looksLikeUuid(value) && !isValidWordCode(value)) {
    return { key: value, code: '', ...SYNTHETIC_RESOLUTION };
  }

  const row = await checkRoom(value).catch((error) => {
    console.error('CALL ERROR:', error?.message ?? error);
    return null;
  });

  const key = row?.room_id ? String(row.room_id) : looksLikeUuid(value) ? value : '';
  return {
    key,
    code: String(row?.code ?? (looksLikeUuid(value) ? '' : value)),
    personal: row?.personal === true,
    status: typeof row?.status === 'string' ? row.status : null,
    host_id: typeof row?.host_id === 'string' ? row.host_id : null,
  };
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
 * The single join guard, shared by the hub and the /call route so the two can
 * never disagree. Built entirely on checkRoom — nothing else is queried.
 */
export const resolveJoin = async (
  input: string,
  options: { password?: string; userId?: string | null } = {},
): Promise<JoinVerdict> => {
  const value = normalizeCode(input);
  if (!value) return { ok: false, reason: 'roomNotFound' };

  const row = await checkRoom(value, options.password ?? '');
  if (!row || !row.room_id || row.status === 'ended') {
    return { ok: false, reason: 'roomNotFound' };
  }

  // A protected room asks for the password before anything else.
  if (row.has_password && !row.ok) return { ok: false, reason: 'password' };

  const isHost = Boolean(options.userId && row.host_id === options.userId);
  const personal = row.personal === true;
  const status = row.status ?? null;

  // The host is never blocked by their own room's rules.
  if (!isHost) {
    if (row.locked === true) return { ok: false, reason: 'meetingLocked' };
    if (personal && status === 'waiting') return { ok: false, reason: 'lineClosed' };
    if (
      typeof row.max_participants === 'number' &&
      typeof row.participant_count === 'number' &&
      row.participant_count >= row.max_participants
    ) {
      return { ok: false, reason: 'meetingFull' };
    }
  }

  const policy: Partial<CallPolicy> = {
    lobby_enabled: row.lobby_enabled === true,
    locked: row.locked === true,
    auto_mute: row.auto_mute === true,
    allow_share: row.allow_share !== false,
    has_password: Boolean(row.has_password),
    ...(typeof row.max_participants === 'number'
      ? { max_participants: row.max_participants }
      : {}),
  };

  // Word-code URLs only: never navigate with a UUID.
  return {
    ok: true,
    code: String(row.code ?? value),
    key: String(row.room_id),
    isHost,
    personal,
    lobby: row.lobby_enabled === true,
    policy,
  };
};

/** Updates a room's lifecycle status, addressed by its public code. */
export const setRoomStatus = async (code: string, status: 'active' | 'ended' | string) => {
  const normalized = normalizeCode(code);
  if (!normalized) return;

  return supabase
    .from('call_rooms')
    .update({
      status,
      ended_at: status === 'ended' ? new Date().toISOString() : null,
    })
    .eq('code', normalized);
};

/** Mirrors a policy change into the room row. Never writes `has_password`. */
export const updateRoomPolicy = async (
  roomKey: string,
  patch: Partial<CallPolicy>,
): Promise<void> => {
  if (!roomKey) return;

  const columns: Record<string, unknown> = {};
  if (typeof patch.lobby_enabled === 'boolean') columns.lobby_enabled = patch.lobby_enabled;
  if (typeof patch.locked === 'boolean') columns.locked = patch.locked;
  if (typeof patch.auto_mute === 'boolean') columns.auto_mute = patch.auto_mute;
  if (typeof patch.allow_share === 'boolean') columns.allow_share = patch.allow_share;
  if (typeof patch.max_participants === 'number') columns.max_participants = patch.max_participants;
  if (Object.keys(columns).length === 0) return;

  const { error } = await supabase.from('call_rooms').update(columns).eq('id', roomKey);
  if (error) console.error('CALL ERROR:', error.message);
};

/**
 * Sets (or clears) the room password. The digest is written against the room's
 * UUID and discarded — never returned, stored, logged or broadcast.
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

// ---------------------------------------------------------------------------
// Personal rooms — one per user, created once and never regenerated.
// ---------------------------------------------------------------------------

export type PersonalRoom = { id: string; code: string; status: string };

/**
 * Finds (or lazily creates) the signed-in user's personal room.
 *
 * The lookup comes first, so an existing line always keeps the code it was
 * given; a code is drawn only when no row exists at all.
 */
export const ensurePersonalRoom = async (userId: string): Promise<PersonalRoom | null> => {
  if (!userId) return null;

  const { data: sessionData } = await supabase.auth.getSession();
  const owner = sessionData.session?.user?.id ?? userId;
  if (!owner) return null;

  const { data: existing, error: findError } = await supabase
    .from('call_rooms')
    .select('id, code, status')
    .eq('host_id', owner)
    .eq('personal', true)
    .maybeSingle();

  if (!findError && existing) {
    const row = existing as { id?: string; code?: string; status?: string };
    return { id: String(row.id ?? ''), code: String(row.code ?? ''), status: String(row.status ?? 'waiting') };
  }

  // Never regenerates: this only runs when the user has no personal row.
  for (let i = 0; i < COLLISION_RETRIES; i++) {
    const code = generateWordCode();

    const { data, error } = await supabase
      .from('call_rooms')
      .insert({
        host_id: owner,
        code,
        status: 'waiting',
        personal: true,
        // Personal rooms default to no lobby and no password.
        lobby_enabled: false,
        password_hash: null,
      })
      .select('id, code, status')
      .single();

    if (!error && data) {
      const row = data as { id?: string; code?: string; status?: string };
      return { id: String(row.id ?? ''), code: String(row.code ?? ''), status: String(row.status ?? 'waiting') };
    }
    if (error && error.code !== '23505') {
      console.error('CALL ERROR:', error.message);
      return null;
    }
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
