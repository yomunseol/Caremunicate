import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

type RoleFilter = 'all' | 'patient' | 'doctor';

const FILTER_TABS: { key: RoleFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'patient', label: 'Patients' },
  { key: 'doctor', label: 'Doctors' },
];

interface ChatListItem {
  conversationId: string;
  peerName: string;
  peerRole: string | null;
  preview: string;
  lastMessageAt: string | null;
}

interface PeerRow {
  conversation_id: string;
  user_id: string;
  role: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  hospital: 'Hospital',
};

const formatTimestamp = (iso: string | null): string => {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

type ChatListProps = {
  onOpenChat?: (conversationId: string) => void;
  /** Pre-select a role tab (e.g. dashboard shows doctors to patients only). */
  initialFilter?: RoleFilter;
};

export function ChatList({ onOpenChat, initialFilter = 'all' }: ChatListProps) {
  const { user } = useAuth();
  const [tab, setTab] = useState<RoleFilter>(initialFilter);
  const [items, setItems] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const loadConversations = async () => {
      setLoading(true);
      setError(null);

      // 1) Conversations the current user participates in, joined with the
      // conversation rows (embed) for preview/sorting metadata.
      const { data, error } = await supabase
        .from('conversation_participants')
        .select('conversation_id, conversations(id, created_at, last_message_preview, last_message_at)')
        .eq('user_id', user.id);

      console.log('Fetched chat list:', data);

      if (cancelled) return;

      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }

      const conversations = new Map<
        string,
        { created_at: string | null; last_message_preview: string | null; last_message_at: string | null }
      >();

      for (const row of (data ?? []) as Array<{ conversation_id: string; conversations: unknown }>) {
        const embedded = Array.isArray(row.conversations)
          ? row.conversations[0]
          : row.conversations;

        if (embedded && typeof embedded === 'object') {
          conversations.set(
            row.conversation_id,
            embedded as {
              created_at: string | null;
              last_message_preview: string | null;
              last_message_at: string | null;
            },
          );
        }
      }

      const conversationIds = [...conversations.keys()];
      if (conversationIds.length === 0) {
        setItems([]);
        setLoading(false);
        return;
      }

      // 2) The other participants of those conversations (their role is
      // snapshotted on the participant row).
      const { data: others, error: othersError } = await supabase
        .from('conversation_participants')
        .select('conversation_id, user_id, role')
        .in('conversation_id', conversationIds)
        .neq('user_id', user.id);

      if (cancelled) return;

      if (othersError) {
        setError(othersError.message);
        setLoading(false);
        return;
      }

      const peerRows = (others ?? []) as PeerRow[];

      // 3) Display names for those peers.
      const peerUserIds = [...new Set(peerRows.map((peer) => peer.user_id))];
      const usernames = new Map<string, string | null>();

      if (peerUserIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from('profiles')
          .select('user_id, username')
          .in('user_id', peerUserIds);

        if (cancelled) return;

        if (profilesError) {
          setError(profilesError.message);
          setLoading(false);
          return;
        }

        for (const profile of (profiles ?? []) as Array<{ user_id: string; username: string | null }>) {
          usernames.set(profile.user_id, profile.username);
        }
      }

      const nextItems: ChatListItem[] = conversationIds.map((conversationId) => {
        const conversation = conversations.get(conversationId)!;
        const peer = peerRows.find((row) => row.conversation_id === conversationId);

        return {
          conversationId,
          peerName: peer ? (usernames.get(peer.user_id) ?? 'Participant') : 'Unknown participant',
          peerRole: peer?.role ?? null,
          preview:
            conversation.last_message_preview?.trim()
              ? conversation.last_message_preview
              : 'No messages yet',
          lastMessageAt: conversation.last_message_at ?? conversation.created_at,
        };
      });

      nextItems.sort((a, b) =>
        (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''),
      );

      setItems(nextItems);
      setLoading(false);
    };

    void loadConversations();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const counts = useMemo(
    () => ({
      all: items.length,
      patient: items.filter((item) => item.peerRole === 'patient').length,
      doctor: items.filter((item) => item.peerRole === 'doctor').length,
    }),
    [items],
  );

  const visibleItems = useMemo(
    () => (tab === 'all' ? items : items.filter((item) => item.peerRole === tab)),
    [items, tab],
  );

  const openChat = (conversationId: string) => {
    if (onOpenChat) {
      onOpenChat(conversationId);
      return;
    }
    window.location.hash = `/chat/${conversationId}`;
  };

  if (!user) {
    return <p style={styles.empty}>Sign in to see your conversations.</p>;
  }

  return (
    <section aria-label="Conversations" style={styles.wrapper}>
      <div style={styles.header}>
        <h2 style={styles.title}>Conversations</h2>

        <div role="tablist" aria-label="Filter conversations by role" style={styles.tabs}>
          {FILTER_TABS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              style={{
                ...styles.tab,
                ...(tab === key ? styles.tabActive : null),
              }}
            >
              {label}
              <span style={styles.tabCount}>{counts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div aria-busy="true" aria-label="Loading conversations">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} style={styles.skeletonRow}>
              <div style={styles.skeletonAvatar} />
              <div style={styles.skeletonLines}>
                <div style={styles.skeletonLineWide} />
                <div style={styles.skeletonLineNarrow} />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <p role="alert" style={styles.error}>{error}</p>
      ) : visibleItems.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>
            {items.length === 0 ? 'No conversations yet' : `No ${tab === 'patient' ? 'patient' : 'doctor'} chats`}
          </p>
          <p style={styles.emptyHint}>
            {items.length === 0
              ? 'Start a conversation from a doctor or patient profile.'
              : 'Try a different filter.'}
          </p>
        </div>
      ) : (
        <ul style={styles.list}>
          {visibleItems.map((item) => (
            <li key={item.conversationId} style={styles.listItem}>
              <button
                type="button"
                onClick={() => openChat(item.conversationId)}
                style={styles.chatButton}
                aria-label={`Open chat with ${item.peerName}`}
              >
                <span style={styles.avatar}>{item.peerName.charAt(0).toUpperCase()}</span>

                <span style={styles.chatBody}>
                  <span style={styles.chatTopRow}>
                    <strong style={styles.peerName}>{item.peerName}</strong>
                    <span style={styles.roleBadge}>
                      {ROLE_LABELS[item.peerRole ?? ''] ?? 'Care member'}
                    </span>
                  </span>
                  <span style={styles.chatBottomRow}>
                    <span style={styles.preview}>{item.preview}</span>
                    <time style={styles.time}>{formatTimestamp(item.lastMessageAt)}</time>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    width: '100%',
    maxWidth: 640,
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
  title: {
    margin: 0,
    fontSize: 20,
    fontWeight: 700,
  },
  tabs: {
    display: 'flex',
    gap: 6,
    padding: 4,
    borderRadius: 999,
    background: 'rgba(0, 0, 0, 0.04)',
  },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    background: 'transparent',
    padding: '6px 12px',
    borderRadius: 999,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-muted, #555)',
    cursor: 'pointer',
  },
  tabActive: {
    background: '#fff',
    color: 'var(--accent-strong, #2d7a5f)',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.12)',
  },
  tabCount: {
    fontSize: 12,
    opacity: 0.7,
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  listItem: {
    margin: 0,
  },
  chatButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    textAlign: 'left',
    padding: '12px 14px',
    border: '1px solid rgba(0, 0, 0, 0.06)',
    borderRadius: 14,
    background: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'box-shadow 150ms ease, transform 150ms ease',
  },
  avatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 42,
    height: 42,
    flexShrink: 0,
    borderRadius: '50%',
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    fontWeight: 700,
  },
  chatBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
    flex: 1,
  },
  chatTopRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  peerName: {
    fontSize: 15,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  roleBadge: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'capitalize',
    color: 'var(--accent-strong, #2d7a5f)',
    background: 'rgba(62, 169, 133, 0.12)',
    padding: '2px 8px',
    borderRadius: 999,
  },
  chatBottomRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  preview: {
    fontSize: 13,
    color: 'var(--text-muted, #555)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  time: {
    fontSize: 12,
    color: 'var(--text-muted, #555)',
    flexShrink: 0,
  },
  empty: {
    textAlign: 'center',
    padding: '40px 16px',
    color: 'var(--text-muted, #555)',
  },
  emptyTitle: {
    margin: 0,
    fontWeight: 600,
    fontSize: 16,
  },
  emptyHint: {
    margin: '6px 0 0',
    fontSize: 14,
  },
  error: {
    color: '#c0392b',
    padding: 16,
    textAlign: 'center',
  },
  skeletonRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
  },
  skeletonAvatar: {
    width: 42,
    height: 42,
    borderRadius: '50%',
    background: 'rgba(0, 0, 0, 0.08)',
  },
  skeletonLines: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  skeletonLineWide: {
    height: 14,
    width: '45%',
    borderRadius: 6,
    background: 'rgba(0, 0, 0, 0.08)',
  },
  skeletonLineNarrow: {
    height: 12,
    width: '70%',
    borderRadius: 6,
    background: 'rgba(0, 0, 0, 0.05)',
  },
};
