import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';
import { createDirectConversation } from '../lib/conversations';

interface ConversationItem {
  conversationId: string;
  peerName: string;
  peerRole: string;
  preview: string;
  timestamp: string | null;
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
}

const ROLE_LABELS: Record<string, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  hospital: 'Hospital',
};

// Last-message preview, computed client-side: collapse whitespace, cap at 40
// characters, add an ellipsis when truncated.
const previewOf = (content: string | null | undefined): string => {
  const cleaned = (content ?? '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 40 ? `${cleaned.slice(0, 40).trimEnd()}…` : cleaned;
};

const timeAgo = (iso: string | null): string => {
  if (!iso) return '';
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 45) return 'just now';

  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)} min ago`;

  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} hour${Math.floor(hours) > 1 ? 's' : ''} ago`;

  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)} day${Math.floor(days) > 1 ? 's' : ''} ago`;

  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

type ChatListProps = {
  myUserId: string;
  /** 'patient' | 'doctor' | 'hospital' — drives role-aware listing + start CTA. */
  myRole: string;
  onOpenChat: (conversationId: string) => void;
};

export function ChatList({ myUserId, myRole, onOpenChat }: ChatListProps) {
  const isPatient = myRole === 'patient';
  const isDoctor = myRole === 'doctor';

  const [items, setItems] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [startOpen, setStartOpen] = useState(false);
  const [doctors, setDoctors] = useState<Array<{ user_id: string; username: string | null }>>([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Conversations I participate in, joined with conversations, plus the LAST
  // message per conversation (fetched separately — conversations has no
  // last_message_* column in this schema).
  useEffect(() => {
    if (!myUserId) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        // 1) My memberships + embedded conversation rows.
        const { data, error } = await supabase
          .from('conversation_participants')
          .select('conversation_id, role, conversations(id, created_at, created_by, type, name)')
          .eq('user_id', myUserId);

        console.log('ChatList data:', data);

        if (error) throw error;

        const conversations = new Map<
          string,
          { created_at: string | null; type: string | null }
        >();

        for (const row of (data ?? []) as Array<{ conversation_id: string; conversations: unknown }>) {
          const embedded = Array.isArray(row.conversations)
            ? row.conversations[0]
            : row.conversations;

          if (embedded && typeof embedded === 'object') {
            const conversation = embedded as {
              created_at: string | null;
              type: string | null;
            };
            conversations.set(row.conversation_id, conversation);
          }
        }

        const conversationIds = [...conversations.keys()];
        if (cancelled) return;

        if (conversationIds.length === 0) {
          setItems([]);
          return;
        }

        // 2) The other participants (their role is snapshotted on the
        // participant row) — these are the "peers" the UI labels.
        const { data: others, error: othersError } = await supabase
          .from('conversation_participants')
          .select('conversation_id, user_id, role')
          .in('conversation_id', conversationIds)
          .neq('user_id', myUserId);

        if (cancelled) return;
        if (othersError) throw othersError;

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
          if (profilesError) throw profilesError;

          for (const profile of (profiles ?? []) as Array<{ user_id: string; username: string | null }>) {
            usernames.set(profile.user_id, profile.username);
          }
        }

        // 4) The last message per conversation, in ONE query: order all of my
        // conversations' messages newest-first, keep the first row per
        // conversation.
        const { data: messages, error: messagesError } = await supabase
          .from('messages')
          .select('conversation_id, content, created_at')
          .in('conversation_id', conversationIds)
          .order('created_at', { ascending: false })
          .limit(500);

        if (cancelled) return;
        if (messagesError) throw messagesError;

        const lastMessageByConversation = new Map<string, MessageRow>();
        for (const message of (messages ?? []) as MessageRow[]) {
          if (!lastMessageByConversation.has(message.conversation_id)) {
            lastMessageByConversation.set(message.conversation_id, message);
          }
        }

        // 5) Assemble + sort (newest activity first).
        const nextItems: ConversationItem[] = conversationIds.flatMap((conversationId) => {
          const conversation = conversations.get(conversationId);
          const peer = peerRows.find((row) => row.conversation_id === conversationId);
          if (!peer || !conversation) return [];

          const last = lastMessageByConversation.get(conversationId);

          return [
            {
              conversationId,
              peerName: usernames.get(peer.user_id) ?? 'Participant',
              peerRole: peer.role,
              preview: previewOf(last?.content),
              timestamp: last?.created_at ?? conversation.created_at,
            },
          ];
        });

        nextItems.sort((a, b) =>
          (b.timestamp ?? '').localeCompare(a.timestamp ?? ''),
        );

        if (!cancelled) setItems(nextItems);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load conversations.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [myUserId, attempt]);

  // Role-aware listing without tabs: patients see threads with doctors,
  // doctors see threads with patients, everyone else sees all threads.
  const visibleItems = useMemo(() => {
    const allowedPeerRoles =
      isPatient
        ? ['doctor', 'hospital']
        : isDoctor
          ? ['patient']
          : ['patient', 'doctor', 'hospital'];

    return items.filter((item) => allowedPeerRoles.includes(item.peerRole));
  }, [items, isPatient, isDoctor]);

  // Doctor directory for the patient "Start new conversation" flow.
  useEffect(() => {
    if (!isPatient || !startOpen) return;

    let cancelled = false;

    const loadDoctors = async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, username')
        .eq('role', 'doctor')
        .order('username', { ascending: true })
        .limit(50);

      if (cancelled || error) return;
      setDoctors((data ?? []) as Array<{ user_id: string; username: string | null }>);
    };

    void loadDoctors();

    return () => {
      cancelled = true;
    };
  }, [isPatient, startOpen]);

  const handleStartConversation = async () => {
    if (!selectedDoctorId || starting) return;

    setStarting(true);
    setStartError(null);
    try {
      // Idempotent: returns the existing thread if it already exists.
      const conversationId = await createDirectConversation(myUserId, selectedDoctorId);
      onOpenChat(conversationId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start the conversation.');
    } finally {
      setStarting(false);
    }
  };

  const hasAnyConversations = items.length > 0;

  return (
    <div style={styles.wrapper}>
      <div style={styles.headingRow}>
        <div>
          <div className="eyebrow">Care messaging</div>
          <h3 style={styles.title}>
            {isDoctor ? 'Your patients' : isPatient ? 'Your care conversations' : 'Care conversations'}
          </h3>
          <p style={styles.subtitle}>
            {isPatient
              ? 'Message your assigned doctor or start a new consultation.'
              : isDoctor
                ? 'Secure threads with the patients who reach out to you.'
                : 'Secure threads with your care network.'}
          </p>
        </div>

        {isPatient && !startOpen ? (
          <button type="button" onClick={() => setStartOpen(true)} style={styles.primaryButton}>
            + Start New Conversation
          </button>
        ) : null}
      </div>

      {isPatient && startOpen ? (
        <div style={styles.composeRow}>
          <select
            aria-label="Choose a doctor"
            value={selectedDoctorId}
            onChange={(event) => setSelectedDoctorId(event.target.value)}
            style={styles.select}
            disabled={doctors.length === 0}
          >
            <option value="">
              {doctors.length === 0 ? 'No doctors available yet' : 'Choose a doctor…'}
            </option>
            {doctors.map((doctor) => (
              <option key={doctor.user_id} value={doctor.user_id}>
                {doctor.username ?? 'Doctor'}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void handleStartConversation()}
            disabled={!selectedDoctorId || starting}
            style={{ ...styles.primaryButton, ...(selectedDoctorId && !starting ? {} : styles.primaryButtonDisabled) }}
          >
            {starting ? 'Opening…' : 'Start chat'}
          </button>

          <button type="button" onClick={() => setStartOpen(false)} style={styles.cancelButton}>
            Cancel
          </button>
        </div>
      ) : null}

      {startError ? <p role="alert" style={styles.inlineError}>{startError}</p> : null}
      {error ? (
        <div role="alert" style={styles.inlineError}>
          {error}
          <button type="button" onClick={() => setAttempt((n) => n + 1)} style={styles.retryButton}>
            Try again
          </button>
        </div>
      ) : null}

      {loading ? (
        <div aria-busy="true" aria-label="Loading conversations">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} style={styles.card}>
              <div style={styles.cardTopRow}>
                <div style={styles.skeletonAvatar} />
                <div style={styles.skeletonLineWide} />
              </div>
              <div style={styles.skeletonLineNarrow} />
            </div>
          ))}
        </div>
      ) : !error && visibleItems.length === 0 ? (
        <div style={styles.emptyState}>
          <p style={styles.emptyTitle}>
            {hasAnyConversations
              ? isDoctor
                ? 'No patient conversations yet'
                : 'No matching conversations yet'
              : isPatient
                ? 'No conversations yet. Message your assigned doctor or start a new consultation.'
                : isDoctor
                  ? 'No patient conversations yet. Patients can start a thread from their dashboard.'
                  : 'No conversations yet.'}
          </p>
          {isPatient && !hasAnyConversations ? (
            <button type="button" onClick={() => setStartOpen(true)} style={styles.secondaryButton}>
              Start a new consultation
            </button>
          ) : null}
        </div>
      ) : (
        <ul style={styles.list}>
          {visibleItems.map((item) => (
            <li key={item.conversationId}>
              <button
                type="button"
                onClick={() => onOpenChat(item.conversationId)}
                style={styles.card}
                aria-label={`Open chat with ${item.peerName}`}
              >
                <span style={styles.cardTopRow}>
                  <span style={styles.avatar}>{item.peerName.charAt(0).toUpperCase()}</span>
                  <span style={styles.cardHeaderCopy}>
                    <strong style={styles.peerName}>{item.peerName}</strong>
                    <span style={styles.roleBadge}>{ROLE_LABELS[item.peerRole] ?? 'Care member'}</span>
                  </span>
                  <time style={styles.time}>{timeAgo(item.timestamp)}</time>
                </span>

                <span style={styles.preview}>
                  {item.preview || 'No messages yet — say hello to start.'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    width: '100%',
  },
  headingRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 14,
    color: 'var(--text-muted, #555)',
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
    padding: '16px 18px',
    background: '#fff',
    border: '1px solid rgba(0, 0, 0, 0.07)',
    borderRadius: 16,
    cursor: 'pointer',
    transition: 'box-shadow 150ms ease, transform 150ms ease',
  },
  cardTopRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
  },
  cardHeaderCopy: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  avatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 40,
    height: 40,
    flexShrink: 0,
    borderRadius: '50%',
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    fontWeight: 700,
  },
  peerName: {
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
  preview: {
    fontSize: 14,
    color: 'var(--text-muted, #555)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingLeft: 52,
  },
  time: {
    flexShrink: 0,
    fontSize: 12,
    color: 'var(--text-muted, #777)',
  },
  primaryButton: {
    border: 'none',
    borderRadius: 999,
    padding: '10px 18px',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    color: '#fff',
    background: 'var(--accent, #3ea985)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  primaryButtonDisabled: {
    background: 'rgba(0, 0, 0, 0.12)',
    cursor: 'not-allowed',
  },
  secondaryButton: {
    border: '1px solid var(--accent, #3ea985)',
    borderRadius: 999,
    padding: '10px 18px',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    color: 'var(--accent-strong, #2d7a5f)',
    background: 'transparent',
    cursor: 'pointer',
  },
  cancelButton: {
    border: '1px solid rgba(0, 0, 0, 0.12)',
    borderRadius: 999,
    padding: '10px 16px',
    fontSize: 14,
    fontFamily: 'inherit',
    background: '#fff',
    color: 'var(--text-muted, #555)',
    cursor: 'pointer',
  },
  composeRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  select: {
    flex: 1,
    minWidth: 200,
    border: '1px solid rgba(0, 0, 0, 0.12)',
    borderRadius: 999,
    padding: '9px 14px',
    fontSize: 14,
    fontFamily: 'inherit',
    background: '#fff',
  },
  emptyState: {
    textAlign: 'center',
    padding: '36px 16px',
    border: '1px dashed rgba(0, 0, 0, 0.14)',
    borderRadius: 16,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  emptyTitle: {
    margin: 0,
    fontSize: 15,
    color: 'var(--text-muted, #555)',
    maxWidth: 420,
  },
  inlineError: {
    margin: 0,
    color: '#c0392b',
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  retryButton: {
    border: '1px solid currentColor',
    borderRadius: 999,
    padding: '4px 12px',
    fontSize: 13,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  skeletonAvatar: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    background: 'rgba(0, 0, 0, 0.08)',
  },
  skeletonLineWide: {
    height: 14,
    width: '35%',
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
