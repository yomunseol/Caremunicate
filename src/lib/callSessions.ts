import { supabase } from './supabase';
import { firstRow } from './rows';

// ---------------------------------------------------------------------------
// Call sessions — the persisted row behind clinical docs. Chat lives in its own
// table (call_chat_messages) via lib/callChat.ts.
//
// One row per live call, keyed by the room. The engine creates/joins it on
// connect and closes it on teardown. Reads degrade quietly on a project that
// has not run 202609230001_call_sessions.sql, exactly like the appointments
// layer.
// ---------------------------------------------------------------------------

export type CallChatEntry = {
  id: string;
  sender: string;
  body: string;
  at: string;
};

export type CallSession = {
  id: string;
  room_key: string;
  room_code: string | null;
  host_id: string | null;
  kind: string;
  participant_ids: string[];
  chat_log: CallChatEntry[];
  has_recording: boolean;
  recording_url: string | null;
  started_at: string;
  ended_at: string | null;
};

const normalize = (row: Record<string, unknown> | null): CallSession | null => {
  if (!row) return null;
  return {
    ...(row as unknown as CallSession),
    chat_log: Array.isArray(row.chat_log) ? (row.chat_log as CallChatEntry[]) : [],
  };
};

/** Create-or-append-me; returns the live row, including its existing chat_log. */
export const ensureCallSession = async (payload: {
  roomKey: string;
  roomCode: string | null;
  hostId: string | null;
  kind: string;
}): Promise<CallSession | null> => {
  if (!payload.roomKey) return null;

  const { data, error } = await supabase.rpc('join_call_session', {
    p_room_key: payload.roomKey,
    p_room_code: payload.roomCode,
    p_host_id: payload.hostId,
    p_kind: payload.kind,
  });

  if (error) {
    console.error('CALL ERROR:', error.message);
    return null;
  }
  return normalize(firstRow<Record<string, unknown>>(data));
};

/** Read one session (used for the docs lock check — is it still live?). */
export const loadCallSession = async (sessionId: string): Promise<CallSession | null> => {
  if (!sessionId) return null;

  const { data, error } = await supabase
    .from('call_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) {
    console.error('CALL ERROR:', error.message);
    return null;
  }
  return normalize(firstRow<Record<string, unknown>>(data));
};

/** Mark the session over — this is what locks a 'meeting_only' doc. */
export const endCallSession = async (sessionId: string): Promise<void> => {
  if (!sessionId) return;

  const { error } = await supabase
    .from('call_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', sessionId);

  if (error) console.error('CALL ERROR:', error.message);
};

