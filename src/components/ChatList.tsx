import { useEffect, useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';

export interface ChatListItem {
  conversationId: string;
  peerId: string;
  peerName: string;
  peerRole: string;
  preview: string;
  at: string | null;
  lastSenderId: string | null;
}

interface PeerRow {
  conversation_id: string;
  user_id: string;
  role: string;
}

interface MessageRow {
  conversation_id: string;
  content: string;
  created_at: string;
  sender_id: string;
}

const ROLE_LABELS: Record<string, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  hospital: 'Hospital',
};

const previewOf = (content: string | null | undefined): string => {
  const cleaned = (content ?? '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 40 ? `${cleaned.slice(0, 40).trimEnd()}…` : cleaned;
};

const timeAgo = (iso: string | null): string => {
  if (!iso) return '';
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 45) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

type ChatListProps = {
  myUserId: string;
  onOpenChat: (item: ChatListItem) => void;
  onStartNewChat: () => void;
  /** Parent snapshot hook (e.g. for the unread badge while the list is hidden). */
  onLoaded?: (items: ChatListItem[]) => void;
};

// "My Chats" list. Rules enforced here:
//   - 0 conversations + no error -> friendly empty state.
//   - error truthy               -> the REAL database error message in red.
export function ChatList({ myUserId, onOpenChat, onStartNewChat, onLoaded }: ChatListProps) {
  const [items, setItems] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!myUserId) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      const commit = (nextItems: ChatListItem[]) => {
        if (cancelled) return;
        setItems(nextItems);
        onLoaded?.(nextItems);
      };

      try {
        // 1) Conversations I belong to.
        const { data, error } = await supabase
          .from('conversation_participants')
          .select('conversation_id')
          .eq('user_id', myUserId);

        console.log('CHATS:', data, error);

        if (error) throw error;

        const conversationIds = [...new Set((data ?? []).map((row) => row.conversation_id as string))];

        if (conversationIds.length === 0) {
          commit([]);
          return;
        }

        // 2) Other participants (exclude me) + their role snapshots.
        const { data: others, error: othersError } = await supabase
          .from('conversation_participants')
          .select('conversation_id, user_id, role')
          .in('conversation_id', conversationIds)
          .neq('user_id', myUserId);

        if (othersError) throw othersError;

        const peers = new Map<string, PeerRow>();
        for (const peer of (others ?? []) as PeerRow[]) {
          if (!peers.has(peer.conversation_id)) peers.set(peer.conversation_id, peer);
        }

        // 3) Peer display names.
        const peerUserIds = [...new Set([...peers.values()].map((peer) => peer.user_id))];
        const usernames = new Map<string, string>();

        if (peerUserIds.length > 0) {
          const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select('user_id, username')
            .in('user_id', peerUserIds);

          if (profilesError) throw profilesError;

          for (const profile of (profiles ?? []) as Array<{ user_id: string; username: string | null }>) {
            usernames.set(profile.user_id, profile.username ?? '');
          }
        }

        // 4) Last message per conversation (newest-first, first row wins).
        const { data: messages, error: messagesError } = await supabase
          .from('messages')
          .select('conversation_id, content, created_at, sender_id')
          .in('conversation_id', conversationIds)
          .order('created_at', { ascending: false })
          .limit(500);

        if (messagesError) throw messagesError;

        const lastByConversation = new Map<string, MessageRow>();
        for (const message of (messages ?? []) as MessageRow[]) {
          if (!lastByConversation.has(message.conversation_id)) {
            lastByConversation.set(message.conversation_id, message);
          }
        }

        const nextItems: ChatListItem[] = [];
        for (const [conversationId, peer] of peers) {
          const last = lastByConversation.get(conversationId);
          nextItems.push({
            conversationId,
            peerId: peer.user_id,
            peerName: usernames.get(peer.user_id) ?? 'Participant',
            peerRole: peer.role,
            preview: last ? previewOf(last.content) : 'No messages yet — say hello.',
            at: last?.created_at ?? null,
            lastSenderId: last?.sender_id ?? null,
          });
        }

        nextItems.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

        commit(nextItems);
      } catch (err) {
        console.error('[chat] chats load failed:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUserId]);

  if (loading) {
    return (
      <div style={styles.centered}>
        <span style={styles.spinner} aria-hidden="true" />
        <p style={styles.muted}>Loading conversations…</p>
      </div>
    );
  }

  // Real database error surfaced verbatim (only when error is truthy).
  if (error) {
    return (
      <div style={styles.centered}>
        <p role="alert" style={styles.errorText}>{error}</p>
      </div>
    );
  }

  // Success with zero rows — friendly empty state.
  if (items.length === 0) {
    return (
      <div style={styles.centered}>
        <p style={styles.emptyTitle}>No conversations yet!</p>
        <p style={styles.muted}>Start a new chat to begin messaging.</p>
        <button type="button" onClick={onStartNewChat} style={styles.primaryButton}>
          New Chat
        </button>
      </div>
    );
  }

  return (
    <ul style={styles.list}>
      {items.map((item) => {
        const isUnread = Boolean(
          item.lastSenderId && item.lastSenderId !== myUserId && item.at,
        );
        return (
          <li key={item.conversationId}>
            <button
              type="button"
              onClick={() => onOpenChat(item)}
              style={styles.row}
              aria-label={`Open chat with ${item.peerName}`}
            >
              <span style={styles.avatar}>{item.peerName.charAt(0).toUpperCase()}</span>
              <span style={styles.copy}>
                <span style={styles.rowTop}>
                  <strong style={styles.name}>{item.peerName}</strong>
                  <time style={styles.time}>{timeAgo(item.at)}</time>
                </span>
                <span style={isUnread ? styles.previewUnread : styles.preview}>
                  {item.preview}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const styles: Record<string, CSSProperties> = {
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    overflowY: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
    padding: '10px',
    background: '#fff',
    border: '1px solid rgba(0, 0, 0, 0.06)',
    borderRadius: 12,
    cursor: 'pointer',
  },
  avatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 38,
    height: 38,
    flexShrink: 0,
    borderRadius: '50%',
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    fontWeight: 700,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  name: {
    fontSize: 14,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  time: {
    flexShrink: 0,
    fontSize: 11,
    color: 'var(--text-muted, #777)',
  },
  preview: {
    fontSize: 13,
    color: 'var(--text-muted, #555)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  previewUnread: {
    fontSize: 13,
    color: '#222',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  centered: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '0 12px',
    textAlign: 'center',
  },
  emptyTitle: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
  },
  muted: {
    margin: 0,
    fontSize: 13,
    color: 'var(--text-muted, #777)',
  },
  errorText: {
    margin: 0,
    fontSize: 13,
    color: '#c0392b',
  },
  primaryButton: {
    border: 'none',
    borderRadius: 999,
    padding: '9px 18px',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    color: '#fff',
    background: 'var(--accent, #3ea985)',
    cursor: 'pointer',
  },
  spinner: {
    width: 16,
    height: 16,
    border: '2px solid rgba(62, 169, 133, 0.3)',
    borderTopColor: 'var(--accent, #3ea985)',
    borderRadius: '50%',
    display: 'inline-block',
  },
};
