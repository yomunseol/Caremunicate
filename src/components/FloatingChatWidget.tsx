import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { MessageCircle, X, Send } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { createDirectConversation } from '../lib/conversations';
import { useRealtimeChat } from '../hooks/useRealtimeChat';
import { SearchUsers, type SearchUserResult } from './SearchUsers';

// ---------------------------------------------------------------------------
// Tailwind equivalents for the notes in this file:
//   fixed wrapper  -> "fixed bottom-4 left-4 z-50"
//   circular button-> "rounded-full bg-[var(--accent,#3ea985)]"
//   window panel   -> "w-[350px] max-w-[calc(100vw-2rem)] h-[500px] rounded-2xl
//                     shadow-xl bg-white"
// The project has no Tailwind build step, so the same design tokens are used
// via inline styles (consistent with PasswordAuth/TwoFactorSetup/ChatWindow).
// ---------------------------------------------------------------------------

interface InboxItem {
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

// ---------------------------------------------------------------------------
// Thread view (inline chat) — reuses useRealtimeChat for live messages.
// ---------------------------------------------------------------------------

type Thread = {
  conversationId: string;
  peerName: string;
  peerRole: string;
};

function ThreadView({
  thread,
  myUserId,
  onBack,
}: {
  thread: Thread;
  myUserId: string;
  onBack: () => void;
}) {
  const { messages, loading, error, sendMessage } = useRealtimeChat(thread.conversationId);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const canSend = !loading && !sending && draft.trim().length > 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !canSend) return;

    setSending(true);
    setSendError(null);
    try {
      await sendMessage(content);
      setDraft('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send your message.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={styles.thread}>
      <div style={styles.threadHeader}>
        <button type="button" onClick={onBack} style={styles.backButton} aria-label="Back to chats">
          ←
        </button>
        <div style={styles.threadPeer}>
          <strong style={styles.threadPeerName}>{thread.peerName}</strong>
          <span style={styles.roleBadge}>{ROLE_LABELS[thread.peerRole] ?? 'Care member'}</span>
        </div>
      </div>

      <div style={styles.messages} aria-live="polite" aria-busy={loading}>
        {loading ? (
          <p style={styles.centeredText}>Loading messages…</p>
        ) : messages.length === 0 ? (
          <p style={styles.centeredText}>No messages yet — say hello.</p>
        ) : (
          messages.map((message) => {
            const mine = message.sender_id === myUserId;
            return (
              <div key={message.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                <div style={mine ? styles.bubbleMine : styles.bubbleTheirs}>
                  <p style={styles.bubbleText}>{message.content}</p>
                  <time style={mine ? styles.bubbleTimeMine : styles.bubbleTimeTheirs}>
                    {timeAgo(message.created_at)}
                  </time>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      <div style={styles.composer}>
        {error ? <p role="alert" style={styles.inlineError}>{error}</p> : null}
        {sendError ? <p role="alert" style={styles.inlineError}>{sendError}</p> : null}
        <form onSubmit={handleSubmit} style={styles.composerRow}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={loading ? 'Loading…' : 'Write a message…'}
            aria-label="Message"
            disabled={loading}
            style={styles.composerInput}
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            style={{ ...styles.sendButton, ...(canSend ? styles.sendButtonEnabled : null) }}
          >
            <Send size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main floating widget
// ---------------------------------------------------------------------------

export default function FloatingChatWidget() {
  const { user } = useAuth();
  const myUserId = user?.id ?? '';

  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<'inbox' | 'search'>('inbox');
  const [thread, setThread] = useState<Thread | null>(null);

  const [items, setItems] = useState<InboxItem[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);

  const [myRole, setMyRole] = useState('patient');
  const [roleResolved, setRoleResolved] = useState(false);

  const lastSeenRef = useRef(Date.now());
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Current user's role (drives search direction + copy). Prefer profiles,
  // fall back to signup metadata.
  useEffect(() => {
    if (!myUserId || roleResolved) return;

    let cancelled = false;

    const load = async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('user_id', myUserId)
        .maybeSingle();

      if (cancelled) return;
      if (!error && data?.role) setMyRole(String(data.role));
      else if (user?.user_metadata?.role) setMyRole(String(user.user_metadata.role));
      setRoleResolved(true);
    };

    void load();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUserId]);

  // Load the inbox: my participants -> peers -> peer names -> last messages.
  useEffect(() => {
    if (!isOpen || !myUserId || thread) return;

    let cancelled = false;

    const loadInbox = async () => {
      setInboxLoading(true);
      setInboxError(null);

      try {
        // 1) Conversations I belong to.
        const { data: mine, error: mineError } = await supabase
          .from('conversation_participants')
          .select('conversation_id')
          .eq('user_id', myUserId);

        if (mineError) throw mineError;

        const conversationIds = [...new Set((mine ?? []).map((row) => row.conversation_id as string))];

        if (conversationIds.length === 0) {
          if (!cancelled) setItems([]);
          return;
        }

        // 2) Other participants (exclude me) + their roles.
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

        const nextItems: InboxItem[] = [];
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

        if (!cancelled) setItems(nextItems);
      } catch (err) {
        console.error('[chat] inbox load failed:', err);
        if (!cancelled) {
          setInboxError(err instanceof Error ? err.message : 'Could not load conversations.');
        }
      } finally {
        if (!cancelled) setInboxLoading(false);
      }
    };

    void loadInbox();

    return () => {
      cancelled = true;
    };
  }, [isOpen, myUserId, thread]);

  // Close when clicking outside the widget (optional nicety).
  useEffect(() => {
    if (!isOpen) return;

    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeWidget();
      }
    };

    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Red dot while collapsed: any thread whose last message is from the peer
  // and arrived after the widget was last opened.
  const unreadCount = items.filter(
    (item) => item.lastSenderId && item.lastSenderId !== myUserId && new Date(item.at ?? 0).getTime() > lastSeenRef.current,
  ).length;

  const openThread = (conversationId: string, peerName: string, peerRole: string) => {
    setThread({ conversationId, peerName, peerRole });
    setTab('inbox');
  };

  // Called by the Search tab after picking a user: reuse the existing thread
  // if present, otherwise create one atomically via the RPC.
  const handlePickUser = async (user: SearchUserResult): Promise<void> => {
    console.log('[chat] picking user:', user.user_id);

    const { data: mine, error: mineError } = await supabase
      .from('conversation_participants')
      .select('conversation_id')
      .eq('user_id', myUserId);

    if (mineError) throw mineError;

    const conversationIds = [...new Set((mine ?? []).map((row) => row.conversation_id as string))];

    let conversationId: string | null = null;

    if (conversationIds.length > 0) {
      const { data: existing, error: existingError } = await supabase
        .from('conversation_participants')
        .select('conversation_id')
        .in('conversation_id', conversationIds)
        .eq('user_id', user.user_id)
        .limit(1);

      if (existingError) throw existingError;
      conversationId = (existing?.[0]?.conversation_id as string | undefined) ?? null;
    }

    if (!conversationId) {
      // Idempotent: create_direct_conversation re-checks and returns the
      // existing thread if one was created concurrently.
      conversationId = await createDirectConversation(myUserId, user.user_id);
    }

    lastSeenRef.current = Date.now();
    openThread(conversationId, user.username ?? 'Participant', user.role);
  };

  const toggleOpen = () => {
    if (isOpen) {
      closeWidget();
    } else {
      setTab('inbox');
      setThread(null);
      lastSeenRef.current = Date.now();
      setIsOpen(true);
    }
  };

  const closeWidget = () => {
    setIsOpen(false);
    setThread(null);
    setTab('inbox');
  };

  if (!myUserId) return null;

  return (
    <div ref={rootRef} style={styles.root}>
      {isOpen ? (
        <div style={styles.window} role="dialog" aria-label="Chat">
          <div style={styles.windowHeader}>
            <strong style={styles.windowTitle}>Messages</strong>
            <button type="button" onClick={closeWidget} style={styles.iconButton} aria-label="Close chat">
              <X size={18} />
            </button>
          </div>

          <div style={styles.tabs}>
            {(
              [
                { key: 'inbox', label: 'My Chats' },
                { key: 'search', label: 'New Chat' },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setTab(key);
                  if (key === 'inbox') setThread(null);
                }}
                style={{ ...styles.tab, ...(tab === key ? styles.tabActive : null) }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={styles.windowBody}>
            {tab === 'search' ? (
              <SearchUsers myRole={myRole} onPick={handlePickUser} />
            ) : thread ? (
              <ThreadView thread={thread} myUserId={myUserId} onBack={() => setThread(null)} />
            ) : (
              renderInbox({
                items,
                loading: inboxLoading,
                error: inboxError,
                myUserId,
                onOpen: openThread,
                onGoSearch: () => setTab('search'),
              })
            )}
          </div>
        </div>
      ) : null}

      <button type="button" onClick={toggleOpen} style={styles.fab} aria-label={isOpen ? 'Close chat' : 'Open chat'}>
        {isOpen ? <X size={22} /> : <MessageCircle size={22} />}
        {!isOpen && unreadCount > 0 ? (
          <span style={styles.unreadDot} aria-label={`${unreadCount} unread conversations`}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inbox list renderer (kept as a pure function of the widget's state so the
// same fetch logic can drive both the list and the unread badge).
// ---------------------------------------------------------------------------

function renderInbox({
  items,
  loading,
  error,
  myUserId,
  onOpen,
  onGoSearch,
}: {
  items: InboxItem[];
  loading: boolean;
  error: string | null;
  myUserId: string;
  onOpen: (conversationId: string, peerName: string, peerRole: string) => void;
  onGoSearch: () => void;
}): ReactNode {
  if (loading) {
    return (
      <div style={styles.centeredBox}>
        <span style={styles.spinner} aria-hidden="true" />
        <p style={styles.centeredText}>Loading conversations…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.centeredBox}>
        <p role="alert" style={styles.inlineError}>{error}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={styles.centeredBox}>
        <p style={styles.emptyTitle}>No active chats.</p>
        <p style={styles.centeredText}>Search for a doctor/patient to start one.</p>
        <button type="button" onClick={onGoSearch} style={styles.primaryButton}>
          New Chat
        </button>
      </div>
    );
  }

  return (
    <ul style={styles.inboxList}>
      {items.map((item) => {
        const isUnread = item.lastSenderId && item.lastSenderId !== myUserId && item.at ? true : false;
        return (
          <li key={item.conversationId}>
            <button
              type="button"
              onClick={() => onOpen(item.conversationId, item.peerName, item.peerRole)}
              style={styles.inboxRow}
              aria-label={`Open chat with ${item.peerName}`}
            >
              <span style={styles.inboxAvatar}>{item.peerName.charAt(0).toUpperCase()}</span>
              <span style={styles.inboxCopy}>
                <span style={styles.inboxTop}>
                  <strong style={styles.inboxName}>{item.peerName}</strong>
                  <time style={styles.inboxTime}>{timeAgo(item.at)}</time>
                </span>
                <span style={{ ...styles.inboxPreview, ...(isUnread ? styles.inboxPreviewUnread : null) }}>
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
  root: {
    position: 'fixed',
    left: 16,
    bottom: 16,
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 12,
  },
  fab: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 56,
    height: 56,
    borderRadius: '50%',
    border: 'none',
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    cursor: 'pointer',
    boxShadow: '0 8px 20px rgba(62, 169, 133, 0.35)',
  },
  unreadDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    padding: '0 4px',
    borderRadius: 999,
    background: '#e74c3c',
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  window: {
    width: 350,
    maxWidth: 'calc(100vw - 2rem)',
    height: 500,
    maxHeight: 'calc(100vh - 7rem)',
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    borderRadius: 18,
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.18)',
    border: '1px solid rgba(0, 0, 0, 0.08)',
    overflow: 'hidden',
  },
  windowHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    background: 'rgba(62, 169, 133, 0.08)',
  },
  windowTitle: {
    fontSize: 16,
  },
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(0, 0, 0, 0.05)',
    cursor: 'pointer',
    color: 'var(--text-muted, #555)',
  },
  tabs: {
    display: 'flex',
    gap: 4,
    padding: '8px 10px 0',
  },
  tab: {
    flex: 1,
    padding: '8px 0',
    border: 'none',
    background: 'transparent',
    borderRadius: 10,
    fontFamily: 'inherit',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-muted, #555)',
    cursor: 'pointer',
  },
  tabActive: {
    background: 'rgba(62, 169, 133, 0.12)',
    color: 'var(--accent-strong, #2d7a5f)',
  },
  windowBody: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    padding: 12,
  },
  inboxList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    overflowY: 'auto',
  },
  inboxRow: {
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
  inboxAvatar: {
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
  inboxCopy: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  inboxTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  inboxName: {
    fontSize: 14,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  inboxTime: {
    flexShrink: 0,
    fontSize: 11,
    color: 'var(--text-muted, #777)',
  },
  inboxPreview: {
    fontSize: 13,
    color: 'var(--text-muted, #555)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  inboxPreviewUnread: {
    color: '#222',
    fontWeight: 600,
  },
  thread: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  threadHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 10,
    borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
  },
  backButton: {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 16,
    color: 'var(--accent-strong, #2d7a5f)',
    padding: 0,
  },
  threadPeer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  threadPeerName: {
    fontSize: 15,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  roleBadge: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'capitalize',
    color: 'var(--accent-strong, #2d7a5f)',
    background: 'rgba(62, 169, 133, 0.12)',
    padding: '2px 8px',
    borderRadius: 999,
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '12px 0',
  },
  bubbleMine: {
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    padding: '8px 12px',
    borderRadius: '14px 14px 4px 14px',
    maxWidth: '82%',
  },
  bubbleTheirs: {
    background: 'rgba(0, 0, 0, 0.05)',
    color: '#222',
    padding: '8px 12px',
    borderRadius: '14px 14px 14px 4px',
    maxWidth: '82%',
  },
  bubbleText: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.4,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  bubbleTimeMine: {
    display: 'block',
    marginTop: 4,
    fontSize: 10,
    opacity: 0.75,
  },
  bubbleTimeTheirs: {
    display: 'block',
    marginTop: 4,
    fontSize: 10,
    color: 'var(--text-muted, #777)',
  },
  composer: {
    borderTop: '1px solid rgba(0, 0, 0, 0.06)',
    paddingTop: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  composerRow: {
    display: 'flex',
    gap: 8,
  },
  composerInput: {
    flex: 1,
    border: '1px solid rgba(0, 0, 0, 0.12)',
    borderRadius: 999,
    padding: '8px 14px',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
  },
  sendButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 38,
    height: 38,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(0, 0, 0, 0.12)',
    color: '#fff',
    cursor: 'not-allowed',
  },
  sendButtonEnabled: {
    background: 'var(--accent, #3ea985)',
    cursor: 'pointer',
  },
  inlineError: {
    margin: 0,
    fontSize: 13,
    color: '#c0392b',
    textAlign: 'center',
  },
  centeredBox: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '0 12px',
    textAlign: 'center',
  },
  centeredText: {
    margin: 0,
    fontSize: 13,
    color: 'var(--text-muted, #777)',
  },
  emptyTitle: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
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
