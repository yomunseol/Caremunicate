import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Expand, X, Send, MessageCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { resolveDisplayName } from '../lib/displayName';
import { roleLabelKey } from '../lib/roles';
import { relativeTime } from '../lib/time';
import { createDirectConversation } from '../lib/conversations';
import { useRealtimeChat } from '../hooks/useRealtimeChat';
import { useMessenger } from '../context/MessengerContext';
import { useLang } from '../i18n';
import { ChatList, type ChatListItem } from './ChatList';
import { SearchUsers, type SearchUserResult } from './SearchUsers';

// ---------------------------------------------------------------------------
// The built-in messenger panel (bottom-end, portaled-in-flow at the app root).
//
// It is the ONLY thing that opens a conversation in place: creating or picking
// a chat calls openMessenger() on the global store, which eases the whole
// "new tab / navigate away" defect class — no new browser tab is ever spawned
// here. The full-page #chat/<id> route is reachable only through the Expand
// affordance, which runs in the SAME tab. The Close X hides the panel and keeps
// the conversation.
//
// On <md the panel renders as a bottom sheet (70vh, rounded top) via the
// .chat-widget-panel class.
// ---------------------------------------------------------------------------

// The design tokens are applied via inline styles (no Tailwind build step).

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
  onExpand,
  onClose,
}: {
  thread: Thread;
  myUserId: string;
  onBack: () => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const { messages, loading, error, sendMessage } = useRealtimeChat(thread.conversationId);
  const { t, tString, locale } = useLang();
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
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={styles.thread}>
      <div className="chat-thread-header" style={styles.threadHeader}>
        <button type="button" onClick={onBack} style={styles.backButton} aria-label={t('chat.backToChats')}>
          ←
        </button>
        <div style={styles.threadPeer}>
          <strong className="chat-thread-name" style={styles.threadPeerName}>
            {thread.peerName?.trim() || t('chat.participant')}
          </strong>
          <span className="chat-role-badge" style={styles.roleBadge}>
            {t(roleLabelKey(thread.peerRole))}
          </span>
        </div>
        <div className="chat-thread-actions" style={styles.threadActions}>
          <button
            type="button"
            onClick={onExpand}
            style={styles.iconButton}
            aria-label={t('chat.expand')}
            title={t('chat.expand')}
          >
            <Expand size={16} />
          </button>
          <button
            type="button"
            onClick={onClose}
            style={styles.iconButton}
            aria-label={t('chat.closeChat')}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div style={styles.messages} aria-live="polite" aria-busy={loading}>
        {loading ? (
          <p style={styles.centeredText}>{t('chat.loadingMessages')}</p>
        ) : messages.length === 0 ? (
          <p style={styles.centeredText}>{t('chat.noMessages')}</p>
        ) : (
          messages.map((message) => {
            const mine = message.sender_id === myUserId;
            return (
              <div key={message.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                <div style={mine ? styles.bubbleMine : styles.bubbleTheirs}>
                  <p style={styles.bubbleText}>{message.content}</p>
                  <time style={mine ? styles.bubbleTimeMine : styles.bubbleTimeTheirs}>
                    {relativeTime(message.created_at, locale, t('chat.justNow'))}
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
            placeholder={loading ? t('chat.loadingMessages') : t('chat.writeMessage')}
            aria-label={t('chat.messageAria')}
            disabled={loading}
            style={styles.composerInput}
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label={tString('chat.sendAria')}
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
// Main floating widget (bottom-end)
// ---------------------------------------------------------------------------

export default function FloatingChatWidget() {
  const { user } = useAuth();
  const { t, tString } = useLang();
  const { open: isOpen, target, setOpen, openMessenger, closeMessenger } = useMessenger();
  const myUserId = user?.id ?? '';

  const [tab, setTab] = useState<'inbox' | 'search'>('inbox');
  const [thread, setThread] = useState<Thread | null>(null);

  // Snapshot of the chat list, kept by ChatList via onLoaded so the collapsed
  // widget can still render the unread badge.
  const [snapshot, setSnapshot] = useState<ChatListItem[]>([]);

  const lastSeenRef = useRef(Date.now());
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The global store drives what the panel shows. Opening a conversation from
  // anywhere (dashboard, chat list, new-chat) lands here — in place.
  useEffect(() => {
    if (!target) return;
    setTab('inbox');
    setThread({
      conversationId: target.conversationId,
      peerName: target.peerName ?? '',
      peerRole: target.peerRole ?? '',
    });
    lastSeenRef.current = Date.now();
  }, [target]);

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

  // Dashboard cards open the widget through a window event, so the messenger
  // stays the single place that owns chat state.
  useEffect(() => {
    const onOpenChat = (event: Event) => {
      const detail = (
        event as CustomEvent<{ conversationId: string; peerName: string; peerRole: string } | null>
      ).detail;

      lastSeenRef.current = Date.now();

      if (detail) {
        openMessenger(detail);
      } else {
        setOpen(true);
        setTab('search');
        setThread(null);
      }
    };

    window.addEventListener('caremunicate:open-chat', onOpenChat);
    return () => window.removeEventListener('caremunicate:open-chat', onOpenChat);
  }, [openMessenger, setOpen]);

  // Red dot while collapsed: any thread whose last message is from the peer
  // and arrived after the widget was last opened.
  const unreadCount = snapshot.filter(
    (item) => item.lastSenderId && item.lastSenderId !== myUserId && new Date(item.at ?? 0).getTime() > lastSeenRef.current,
  ).length;

  const openThread = (conversationId: string, peerName: string, peerRole: string) => {
    openMessenger({ conversationId, peerName, peerRole });
  };

  // Called by the Search tab after picking a user: reuse the existing thread
  // if present, otherwise create one atomically via the RPC. Either way the
  // panel opens IN PLACE — no navigation, no new tab.
  const handlePickUser = async (picked: SearchUserResult): Promise<void> => {
    console.log('[chat] picking user:', picked.user_id);

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
        .eq('user_id', picked.user_id)
        .limit(1);

      if (existingError) throw existingError;
      conversationId = (existing?.[0]?.conversation_id as string | undefined) ?? null;
    }

    if (!conversationId) {
      // Idempotent: create_direct_conversation re-checks and returns the
      // existing thread if one was created concurrently.
      conversationId = await createDirectConversation(myUserId, picked.user_id);
    }

    lastSeenRef.current = Date.now();
    openMessenger({
      conversationId,
      peerName: resolveDisplayName(picked.username, picked.email, t('chat.participant')),
      peerRole: picked.role,
    });
  };

  const closeWidget = () => {
    closeMessenger();
    setThread(null);
    setTab('inbox');
  };

  // Expand = the ONLY path to the full-page route, and it stays in the SAME tab.
  const expandToFullPage = (conversationId: string) => {
    closeWidget();
    window.location.hash = `#chat/${conversationId}`;
  };

  const toggleOpen = () => {
    if (isOpen) {
      closeWidget();
    } else {
      setTab('inbox');
      setThread(null);
      lastSeenRef.current = Date.now();
      setOpen(true);
    }
  };

  if (!myUserId) return null;

  return (
    <div ref={rootRef} style={styles.root}>
      {isOpen ? (
        <div className="chat-widget-panel" style={styles.window} role="dialog" aria-label={t('chat.messages')}>
          <div style={styles.windowHeader}>
            <strong style={styles.windowTitle}>{t('chat.messages')}</strong>
            <button type="button" onClick={closeWidget} style={styles.iconButton} aria-label={t('chat.closeChat')}>
              <X size={18} />
            </button>
          </div>

          <div style={styles.tabs}>
            {(
              [
                { key: 'inbox', label: t('chat.myChats') },
                { key: 'search', label: t('chat.newChat') },
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
              <SearchUsers onPick={handlePickUser} />
            ) : thread ? (
              <ThreadView
                thread={thread}
                myUserId={myUserId}
                onBack={() => setThread(null)}
                onExpand={() => expandToFullPage(thread.conversationId)}
                onClose={closeWidget}
              />
            ) : (
              <ChatList
                myUserId={myUserId}
                onOpenChat={(item) => openThread(item.conversationId, item.peerName, item.peerRole)}
                onStartNewChat={() => setTab('search')}
                onLoaded={setSnapshot}
              />
            )}
          </div>
        </div>
      ) : null}

      <button type="button" onClick={toggleOpen} style={styles.fab} aria-label={isOpen ? t('chat.closeChat') : t('chat.openChat')}>
        {isOpen ? <X size={22} /> : <MessageCircle size={22} />}
        {!isOpen && unreadCount > 0 ? (
          <span style={styles.unreadDot} aria-label={tString('chat.unread', { count: unreadCount })}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'fixed',
    // Bottom-end corner of the viewport, so it stays the same corner under RTL.
    insetInlineEnd: 16,
    bottom: 16,
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
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
    insetInlineEnd: -2,
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
  // Box sizing lives in .chat-widget-panel (globals.css) so the <md bottom-sheet
  // media query can override it — inline styles would win otherwise.
  window: {
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
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
    flex: 1,
  },
  threadActions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  threadPeerName: {
    fontSize: 15,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  roleBadge: {
    flexShrink: 0,
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
  centeredText: {
    margin: 'auto',
    fontSize: 13,
    color: 'var(--text-muted, #777)',
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
  },
};
