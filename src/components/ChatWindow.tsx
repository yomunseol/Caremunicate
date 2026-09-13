import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { resolveDisplayName } from '../lib/displayName';
import { roleLabelKey } from '../lib/roles';
import { useRealtimeChat } from '../hooks/useRealtimeChat';
import { useLang } from '../i18n';

interface ParticipantMeta {
  userId: string;
  role: string;
  name: string;
}

const formatMessageTime = (iso: string): string => {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

type ChatWindowProps = {
  conversationId: string;
};

// Loads participants + display names for a conversation. RLS guarantees this
// returns rows ONLY if the signed-in user is a participant, so an empty
// result doubles as the access check.
async function fetchParticipants(conversationId: string, participantLabel: string) {
  const { data, error } = await supabase
    .from('conversation_participants')
    .select('user_id, role')
    .eq('conversation_id', conversationId);

  if (error) throw error;

  const rows = (data ?? []) as Array<{ user_id: string; role: string }>;
  const userIds = rows.map((row) => row.user_id);

  // Display names: username, else the email prefix. Never empty.
  const displayNames = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('*')
      .in('user_id', userIds);

    if (profilesError) throw profilesError;

    for (const profile of (profiles ?? []) as Array<{
      user_id: string;
      username: string | null;
      email?: string | null;
    }>) {
      displayNames.set(profile.user_id, resolveDisplayName(profile.username, profile.email, participantLabel));
    }
  }

  return rows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    name: displayNames.get(row.user_id) ?? participantLabel,
  }));
}

export default function ChatWindow({ conversationId }: ChatWindowProps) {
  const { user } = useAuth();
  const { t } = useLang();
  const { messages, loading, error, sendMessage } = useRealtimeChat(conversationId);

  const roleLabel = (role: string) => t(roleLabelKey(role));

  const [participants, setParticipants] = useState<ParticipantMeta[]>([]);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const firstLoadDone = useRef(false);

  // Participant + access verification (empty result under RLS = no access).
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setMetaLoading(true);
      setMetaError(null);
      try {
        const rows = await fetchParticipants(conversationId, t('chat.participant'));
        if (cancelled) return;

        if (rows.length === 0) {
          setMetaError(t('chat.conversationMissing'));
          setParticipants([]);
          return;
        }
        setParticipants(rows);
      } catch (err) {
        if (!cancelled) {
          setMetaError(err instanceof Error ? err.message : t('chat.detailsError'));
        }
      } finally {
        if (!cancelled) setMetaLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [conversationId, t]);

  // Scroll to the newest message once on load, then on every new message.
  useEffect(() => {
    if (loading && !firstLoadDone.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: firstLoadDone.current ? 'smooth' : 'auto' });
    if (!loading) firstLoadDone.current = true;
  }, [messages.length, loading]);

  const peer = participants.find((p) => p.userId !== user?.id) ?? participants[0];
  const myId = user?.id ?? '';

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
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  if (metaLoading) {
    return (
      <section aria-label={t('chat.conversationAria')} style={styles.window}>
        <div aria-busy="true" style={styles.metaSkeleton}>
          <div style={styles.skeletonAvatar} />
          <div style={styles.skeletonLine} />
        </div>
      </section>
    );
  }

  if (metaError) {
    return (
      <section aria-label={t('chat.conversationAria')} style={styles.window}>
        <div role="alert" style={styles.centeredMessage}>
          <p style={styles.centeredTitle}>{metaError}</p>
          <a href="#profile" style={styles.backLink}>← {t('chat.backAria')}</a>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={t('chat.conversationAria')} style={styles.window}>
      <header style={styles.header}>
        <a href="#profile" style={styles.backLink} aria-label={t('chat.backAria')}>←</a>

        <div style={styles.headerCopy}>
          <strong style={styles.peerName}>{peer?.name ?? t('chat.conversationAria')}</strong>
          {peer ? (
            <span style={styles.roleBadge}>{roleLabel(peer.role)}</span>
          ) : null}
        </div>
      </header>

      <div
        style={styles.messages}
        aria-live="polite"
        aria-busy={loading}
      >
        {loading ? (
          Array.from({ length: 3 }, (_, index) => (
            <div key={index} style={{ ...styles.skeletonBubble, alignSelf: index % 2 === 0 ? 'flex-start' : 'flex-end' }} />
          ))
        ) : messages.length === 0 ? (
          <div style={styles.centeredMessage}>
            <p style={styles.centeredTitle}>{t('chat.noMessagesTitle')}</p>
            <p style={styles.centeredHint}>{t('chat.sayHello')}</p>
          </div>
        ) : (
          messages.map((message) => {
            const mine = message.sender_id === myId;
            const sender = participants.find((p) => p.userId === message.sender_id);

            return (
              <article key={message.id} style={{ ...styles.messageRow, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                <div style={{ maxWidth: '78%', display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', gap: 4 }}>
                  {!mine ? (
                    <span style={styles.senderLine}>
                      <strong>{sender?.name ?? t('chat.participant')}</strong>
                      {sender ? <span style={styles.senderRole}>{roleLabel(sender.role)}</span> : null}
                    </span>
                  ) : null}

                  <div style={mine ? styles.bubbleMine : styles.bubbleTheirs}>
                    <p style={styles.bubbleText}>{message.content}</p>
                  </div>

                  <time style={styles.time}>{formatMessageTime(message.created_at)}</time>
                </div>
              </article>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      <footer style={styles.composer}>
        {error ? <p role="alert" style={styles.inlineError}>{error}</p> : null}
        {sendError ? <p role="alert" style={styles.inlineError}>{sendError}</p> : null}

        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={loading ? t('chat.loadingConversation') : t('chat.writeMessage')}
            aria-label={t('chat.messageAria')}
            disabled={loading}
            style={styles.input}
          />
          <button
            type="submit"
            disabled={!canSend}
            style={{
              ...styles.sendButton,
              ...(canSend ? styles.sendButtonEnabled : null),
            }}
          >
            {sending ? t('chat.sending') : t('chat.send')}
          </button>
        </form>
      </footer>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  window: {
    display: 'flex',
    flexDirection: 'column',
    height: 'min(72vh, 760px)',
    width: '100%',
    maxWidth: 720,
    margin: '0 auto',
    background: '#fff',
    border: '1px solid rgba(0, 0, 0, 0.08)',
    borderRadius: 18,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 18px',
    borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
  },
  backLink: {
    color: 'var(--accent-strong, #2d7a5f)',
    textDecoration: 'none',
    fontWeight: 600,
    fontSize: 15,
  },
  headerCopy: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  peerName: {
    fontSize: 16,
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
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    background: 'rgba(0, 0, 0, 0.015)',
  },
  messageRow: {
    display: 'flex',
    width: '100%',
  },
  senderLine: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'var(--text-muted, #555)',
  },
  senderRole: {
    textTransform: 'capitalize',
    color: 'var(--accent-strong, #2d7a5f)',
  },
  bubbleMine: {
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    padding: '10px 14px',
    borderRadius: '16px 16px 4px 16px',
  },
  bubbleTheirs: {
    background: '#fff',
    border: '1px solid rgba(0, 0, 0, 0.07)',
    color: '#222',
    padding: '10px 14px',
    borderRadius: '16px 16px 16px 4px',
  },
  bubbleText: {
    margin: 0,
    fontSize: 15,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  time: {
    fontSize: 11,
    color: 'var(--text-muted, #777)',
  },
  composer: {
    borderTop: '1px solid rgba(0, 0, 0, 0.06)',
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  form: {
    display: 'flex',
    gap: 8,
  },
  input: {
    flex: 1,
    border: '1px solid rgba(0, 0, 0, 0.12)',
    borderRadius: 999,
    padding: '10px 16px',
    fontSize: 15,
    fontFamily: 'inherit',
    outline: 'none',
  },
  sendButton: {
    border: 'none',
    borderRadius: 999,
    padding: '10px 20px',
    fontSize: 15,
    fontWeight: 600,
    fontFamily: 'inherit',
    color: '#fff',
    background: 'rgba(0, 0, 0, 0.12)',
    cursor: 'not-allowed',
  },
  sendButtonEnabled: {
    background: 'var(--accent, #3ea985)',
    cursor: 'pointer',
  },
  inlineError: {
    margin: 0,
    color: '#c0392b',
    fontSize: 13,
  },
  centeredMessage: {
    margin: 'auto',
    textAlign: 'center',
    padding: '2rem 1rem',
  },
  centeredTitle: {
    margin: 0,
    fontWeight: 600,
    fontSize: 16,
  },
  centeredHint: {
    margin: '6px 0 0',
    fontSize: 14,
    color: 'var(--text-muted, #555)',
  },
  metaSkeleton: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 18px',
    borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
  },
  skeletonAvatar: {
    width: 34,
    height: 34,
    borderRadius: '50%',
    background: 'rgba(0, 0, 0, 0.08)',
  },
  skeletonLine: {
    height: 14,
    width: '35%',
    borderRadius: 6,
    background: 'rgba(0, 0, 0, 0.08)',
  },
  skeletonBubble: {
    height: 40,
    width: '55%',
    borderRadius: 14,
    background: 'rgba(0, 0, 0, 0.05)',
  },
};
