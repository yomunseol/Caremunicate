import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
}

const compareByCreatedAt = (a: ChatMessage, b: ChatMessage) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

export function useRealtimeChat(conversationId: string) {
  const { user: currentUser } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seenIds = useRef<Set<string>>(new Set());

  // Reset local state whenever the active conversation changes.
  useEffect(() => {
    setMessages([]);
    setError(null);
    setLoading(true);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) {
      setLoading(false);
      return;
    }

    let active = true;
    seenIds.current = new Set();

    const upsert = (incoming: ChatMessage) => {
      if (seenIds.current.has(incoming.id)) return;
      seenIds.current.add(incoming.id);

      setMessages((prev) => {
        if (prev.some((m) => m.id === incoming.id)) return prev;
        return [...prev, incoming].sort(compareByCreatedAt);
      });
    };

    // Subscribe before the initial fetch so an INSERT landing between the
    // snapshot and the live stream cannot be lost; duplicates are dropped by
    // the seenIds dedupe above.
    const channel = supabase
      .channel('room:' + conversationId)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          if (!active) return;
          upsert(payload.new as ChatMessage);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('Subscribed to chat:', conversationId);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          if (active) setError('Realtime subscription failed: ' + status);
        }
      });

    const load = async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (!active) return;

      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }

      for (const row of (data ?? []) as ChatMessage[]) upsert(row);
      setLoading(false);
    };

    void load();

    return () => {
      active = false;
      console.log('Unsubscribed');
      channel.unsubscribe();
    };
  }, [conversationId]);

  const sendMessage = useCallback(
    async (content: string): Promise<ChatMessage> => {
      if (!currentUser) throw new Error('Not authenticated — cannot send a message.');

      const { data, error } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: currentUser.id,
          content,
        })
        .select()
        .single();

      if (error) {
        console.log('SEND ERROR:', error);
        throw error;
      }
      return data as ChatMessage;
    },
    [conversationId, currentUser],
  );

  return { messages, loading, error, sendMessage };
}
