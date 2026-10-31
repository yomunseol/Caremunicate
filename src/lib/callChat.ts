import { supabase } from './supabase';
import type { CallChatEntry } from './callSessions';

// ---------------------------------------------------------------------------
// In-call chat persistence — one row per message in public.call_chat_messages,
// keyed by the call room id (`call_id`). Independent of the call_sessions row so
// chat keeps working even if the docs/session migration has not been applied.
//
//   send  -> insert (optimistic echo lives in useCall)
//   load  -> select ... order by created_at (history for late joiners/refresh)
//   live  -> postgres_changes INSERT on the same call_id (dedicated channel)
// ---------------------------------------------------------------------------

export type CallChatMessage = {
  id: string;
  call_id: string;
  user_id: string;
  user_name: string;
  message: string;
  created_at: string;
};

const toEntry = (row: CallChatMessage): CallChatEntry => ({
  id: row.id,
  sender: row.user_name,
  body: row.message,
  at: row.created_at,
});

/** Full persisted history for one call, oldest first. Fails soft. */
export const loadCallChat = async (callId: string): Promise<CallChatEntry[]> => {
  if (!callId) return [];

  const { data, error } = await supabase
    .from('call_chat_messages')
    .select('*')
    .eq('call_id', callId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('CALL CHAT ERROR:', error.message);
    return [];
  }

  return ((data ?? []) as CallChatMessage[]).map(toEntry);
};

/** Persist one message; returns the stored row (or null on failure). */
export const sendCallChat = async (payload: {
  callId: string;
  userId: string;
  userName: string;
  message: string;
}): Promise<CallChatEntry | null> => {
  const message = payload.message.trim();
  if (!payload.callId || !payload.userId || !message) return null;

  const { data, error } = await supabase
    .from('call_chat_messages')
    .insert({
      call_id: payload.callId,
      user_id: payload.userId,
      user_name: payload.userName,
      message,
    })
    .select('*')
    .single();

  if (error) {
    console.error('CALL CHAT ERROR:', error.message);
    return null;
  }

  return data ? toEntry(data as CallChatMessage) : null;
};

/** Stream INSERTs for one call. Returns an unsubscribe. */
export const subscribeCallChat = (
  callId: string,
  onInsert: (entry: CallChatEntry) => void,
): (() => void) => {
  if (!callId) return () => {};

  const channel = supabase
    .channel('call-chat:' + callId)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'call_chat_messages',
        filter: `call_id=eq.${callId}`,
      },
      (payload) => {
        const row = payload.new as CallChatMessage;
        if (row?.id) onInsert(toEntry(row));
      },
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
};
