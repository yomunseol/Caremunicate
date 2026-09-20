import { supabase } from './supabase';
import type { CallPolicy } from './callRooms';

// ---------------------------------------------------------------------------
// Per-host meeting defaults, stored in profiles.call_prefs.
//
// Nothing here touches a password: the prefs record only whether a password is
// required, never the password or its digest.
// ---------------------------------------------------------------------------

export type CallPrefs = {
  waitingRoom: boolean;
  requirePassword: boolean;
  autoMute: boolean;
  allowScreenShare: boolean;
};

export const DEFAULT_CALL_PREFS: CallPrefs = {
  waitingRoom: true,
  requirePassword: false,
  autoMute: false,
  allowScreenShare: true,
};

const flag = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const sanitize = (value: unknown): CallPrefs => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<CallPrefs>;
  return {
    waitingRoom: flag(source.waitingRoom, DEFAULT_CALL_PREFS.waitingRoom),
    requirePassword: flag(source.requirePassword, DEFAULT_CALL_PREFS.requirePassword),
    autoMute: flag(source.autoMute, DEFAULT_CALL_PREFS.autoMute),
    allowScreenShare: flag(source.allowScreenShare, DEFAULT_CALL_PREFS.allowScreenShare),
  };
};

/** Reads the host's saved meeting defaults. A missing column is not an error. */
export const loadCallPrefs = async (userId: string): Promise<CallPrefs> => {
  if (!userId) return DEFAULT_CALL_PREFS;

  const { data, error } = await supabase
    .from('profiles')
    .select('call_prefs')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) return DEFAULT_CALL_PREFS;
  return sanitize((data as { call_prefs?: unknown } | null)?.call_prefs);
};

/** Persists the host's meeting defaults so the next meeting starts configured. */
export const saveCallPrefs = async (userId: string, prefs: CallPrefs): Promise<void> => {
  if (!userId) return;

  const { error } = await supabase.from('profiles').update({ call_prefs: prefs }).eq('user_id', userId);
  if (error) console.error('CALL PREFS ERROR:', error.message);
};

// ---------------------------------------------------------------------------
// The chosen microphone / camera, in `profiles.call_prefs.devices`.
//
// Written with a read-modify-write because `devices` is ONE key inside the same
// JSON object the meeting flags live in, and saveCallPrefs() replaces the whole
// object — going through it would drop one or the other.
// ---------------------------------------------------------------------------

export type DevicePrefs = { micId: string | null; camId: string | null };

const EMPTY_DEVICE_PREFS: DevicePrefs = { micId: null, camId: null };

const deviceId = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

const readCallPrefs = async (userId: string): Promise<Record<string, unknown> | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('call_prefs')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('CALL PREFS ERROR:', error.message);
    return null;
  }
  const prefs = (data as { call_prefs?: unknown } | null)?.call_prefs;
  return prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>) : {};
};

/** The devices this account last used. Absent/garbage values read as null. */
export const loadDevicePrefs = async (userId: string): Promise<DevicePrefs> => {
  if (!userId) return EMPTY_DEVICE_PREFS;

  const prefs = await readCallPrefs(userId);
  if (!prefs) return EMPTY_DEVICE_PREFS;

  const devices = (prefs.devices && typeof prefs.devices === 'object' ? prefs.devices : {}) as Record<
    string,
    unknown
  >;
  return { micId: deviceId(devices.micId), camId: deviceId(devices.camId) };
};

export const saveDevicePrefs = async (userId: string, prefs: DevicePrefs): Promise<void> => {
  if (!userId) return;

  const current = await readCallPrefs(userId);
  if (!current) return;

  const { error } = await supabase
    .from('profiles')
    .update({ call_prefs: { ...current, devices: { micId: prefs.micId, camId: prefs.camId } } })
    .eq('user_id', userId);
  if (error) console.error('CALL PREFS ERROR:', error.message);
};

// ---------------------------------------------------------------------------
// Local, per-device call UI state.
// ---------------------------------------------------------------------------

const SOUNDS_KEY = 'caremunicate:sounds';

/** Event chimes are on unless the user turned them off. Default: on. */
export const readSoundsEnabled = (): boolean => {
  try {
    return window.localStorage.getItem(SOUNDS_KEY) !== 'off';
  } catch {
    return true;
  }
};

export const storeSoundsEnabled = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(SOUNDS_KEY, enabled ? 'on' : 'off');
  } catch {
    /* storage blocked — the in-memory choice still applies */
  }
};

// The room this tab is currently in, so a reload can offer to rejoin it.
const ACTIVE_ROOM_KEY = 'caremunicate:active-room';

export const rememberActiveRoom = (code: string): void => {
  try {
    if (code) window.sessionStorage.setItem(ACTIVE_ROOM_KEY, code);
  } catch {
    /* storage blocked */
  }
};

export const forgetActiveRoom = (): void => {
  try {
    window.sessionStorage.removeItem(ACTIVE_ROOM_KEY);
  } catch {
    /* storage blocked */
  }
};

export const readActiveRoom = (): string | null => {
  try {
    return window.sessionStorage.getItem(ACTIVE_ROOM_KEY);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The room the host JUST created.
//
// onStart is: `const room = await createRoom(settings)` → keep the room → route
// to /call/<room.code>. Because createRoom has already waited for the insert,
// the host needs no resolution round-trip and cannot hit the read-after-write
// race at all. This is deliberately a module-level value, not React state: it
// must be readable synchronously by the route that mounts on the same tick.
//
// It is single-use — the guard consumes it, so a later visit to the same code
// resolves normally.
// ---------------------------------------------------------------------------

export type CreatedRoom = { id: string; code: string };

let createdRoom: CreatedRoom | null = null;

export const stashCreatedRoom = (room: CreatedRoom): void => {
  createdRoom = room?.id && room?.code ? { id: room.id, code: room.code } : null;
};

export const takeCreatedRoom = (code: string): CreatedRoom | null => {
  const room = createdRoom;
  createdRoom = null;
  if (!room) return null;
  return room.code.toLowerCase() === String(code ?? '').toLowerCase() ? room : null;
};

// The host's chosen policy for the room they are about to open. Handed to
// CallPage through sessionStorage so the in-call Security panel starts from the
// real values even when check_call_room does not echo them back.
const PENDING_POLICY_KEY = 'caremunicate:pending-policy';

export const stashPendingPolicy = (policy: Partial<CallPolicy>): void => {
  try {
    window.sessionStorage.setItem(PENDING_POLICY_KEY, JSON.stringify(policy));
  } catch {
    /* storage blocked — the policy simply falls back to defaults */
  }
};

export const takePendingPolicy = (): Partial<CallPolicy> | null => {
  try {
    const raw = window.sessionStorage.getItem(PENDING_POLICY_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PENDING_POLICY_KEY);
    const parsed = JSON.parse(raw) as Partial<CallPolicy>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};
