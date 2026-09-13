import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Call rooms.
//
// Rooms are addressed by a human-readable 4-word code ("mint-fox-river-halo")
// instead of a numeric id — codes are meant to be read aloud and typed.
//
// Passwords never leave the client in plaintext: only the SHA-256 of
// `${normalizedCode}${password}` is sent to Supabase, so the stored value cannot
// be replayed against another room and the raw password is never persisted.
//
// NOTE: `call_rooms` and the `check_call_room` RPC are managed directly in
// Supabase, not by a migration in this repo. Column names below follow the
// fields named in the spec (code / host_id / password_hash / status / ended_at).
// ---------------------------------------------------------------------------

/** Exactly 64 words — 4 independent picks give 64^4 ≈ 16.7M codes. */
export const WORDS = [
  'mint', 'fox', 'dove', 'fern', 'halo', 'iris', 'jade', 'kite', 'luna', 'nova', 'olive', 'pine',
  'rose', 'sage', 'tulip', 'willow', 'amber', 'birch', 'cedar', 'echo', 'flint', 'hazel', 'juniper',
  'lemon', 'meadow', 'onyx', 'pearl', 'quartz', 'river', 'silver', 'thyme', 'maple', 'delta',
  'ginger', 'indigo', 'kelp', 'nectar', 'orchid', 'poppy', 'reed', 'stone', 'umber', 'violet',
  'wave', 'brook', 'cove', 'dune', 'cloud', 'aster', 'briar', 'clover', 'drift', 'ember', 'frost',
  'glade', 'honey', 'ivory', 'jasper', 'lark', 'moss', 'night', 'opal', 'petal', 'rain',
] as const;

const CODE_SEGMENTS = 4;

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

/** Uniform integer in [0, max) — rejection sampling, so no modulo bias. */
const randomIndex = (max: number): number => {
  const limit = Math.floor(0x100000000 / max) * max;
  const bucket = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(bucket);
    if (bucket[0] < limit) return bucket[0] % max;
  }
};

export const generateRoomCode = (): string =>
  Array.from({ length: CODE_SEGMENTS }, () => WORDS[randomIndex(WORDS.length)]).join('-');

/**
 * Trim, lowercase, spaces/underscores → dashes, collapse repeats, and drop the
 * dashes that replacement pushes to either end.
 */
export const normalizeCode = (input: string): string =>
  String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

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

export const createRoom = async (options: CreateRoomOptions = {}): Promise<string> => {
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
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateRoomCode();

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
        .select('code')
        .single();

      if (!error) return String(data?.code ?? code);

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

/** Mirrors a policy change into the room row. Never writes `has_password`. */
export const updateRoomPolicy = async (code: string, patch: Partial<CallPolicy>): Promise<void> => {
  const normalized = normalizeCode(code);
  if (!normalized) return;

  const columns: Record<string, unknown> = {};
  if (typeof patch.lobby_enabled === 'boolean') columns.lobby_enabled = patch.lobby_enabled;
  if (typeof patch.locked === 'boolean') columns.locked = patch.locked;
  if (typeof patch.auto_mute === 'boolean') columns.auto_mute = patch.auto_mute;
  if (typeof patch.allow_share === 'boolean') columns.allow_share = patch.allow_share;
  if (typeof patch.max_participants === 'number') columns.max_participants = patch.max_participants;
  if (Object.keys(columns).length === 0) return;

  const { error } = await supabase.from('call_rooms').update(columns).eq('code', normalized);
  // A project without the policy columns simply keeps them in memory only.
  if (error && error.code !== '42703' && error.code !== 'PGRST204') throw error;
};

/**
 * Sets (or clears) the room password. The digest is written and discarded —
 * it is never returned, stored in state, logged, or broadcast.
 */
export const setRoomPassword = async (code: string, password: string): Promise<void> => {
  const normalized = normalizeCode(code);
  if (!normalized) return;

  const trimmed = (password ?? '').trim();
  const { error } = await supabase
    .from('call_rooms')
    .update({
      password_hash: trimmed ? await hashCallPassword(normalized, trimmed) : null,
    })
    .eq('code', normalized);

  if (error) throw error;
};

/** Resolves the room for a code, or null when no such room exists. */
export const checkRoom = async (code: string, password = ''): Promise<CheckRoomResult | null> => {
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const { data, error } = await supabase.rpc('check_call_room', {
    p_code: normalized,
    // null === "no password supplied"; a passwordless room must not be handed a
    // hash, or the RPC would read it as a wrong-password attempt.
    p_password_hash: password ? await hashCallPassword(normalized, password) : null,
  });

  if (error) throw error;
  return ((data as CheckRoomResult[] | null)?.[0] ?? null) as CheckRoomResult | null;
};

export const setRoomStatus = async (code: string, status: string): Promise<void> => {
  const patch: { status: string; ended_at?: string } = { status };
  if (status === 'ended') patch.ended_at = new Date().toISOString();

  const { error } = await supabase.from('call_rooms').update(patch).eq('code', normalizeCode(code));
  if (error) throw error;
};
