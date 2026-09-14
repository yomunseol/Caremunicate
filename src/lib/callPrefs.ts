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
