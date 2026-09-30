import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Send, X } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';

// ---------------------------------------------------------------------------
// In-call chat slide-over. Reads the single call store; each message is echoed
// locally then persisted through the session RPC, so it survives a refresh.
// ---------------------------------------------------------------------------

type CallChatPanelProps = {
  onClose: () => void;
};

export default function CallChatPanel({ onClose }: CallChatPanelProps) {
  const { t } = useLang();
  const { chatMessages, sendChat, participants } = useCallContext();
  const trapRef = useFocusTrap<HTMLElement>(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');

  const myName = useMemo(
    () => participants.find((person) => person.self)?.name ?? '',
    [participants],
  );

  // Pin to the newest message.
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chatMessages]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    sendChat(body);
    setDraft('');
  };

  return (
    <aside
      ref={trapRef}
      className="call-participants call-chat"
      style={styles.panel}
      role="dialog"
      aria-label={t('call.chat')}
    >
      <header style={styles.head}>
        <strong>{t('call.chat')}</strong>
        <button
          type="button"
          className="call-panel-close"
          onClick={onClose}
          aria-label={t('common.close')}
          style={styles.close}
        >
          <X size={16} />
        </button>
      </header>

      <div ref={listRef} style={styles.list} aria-live="polite">
        {chatMessages.length === 0 ? (
          <p style={styles.empty}>{t('chat.noMessages')}</p>
        ) : (
          chatMessages.map((entry) => {
            const mine = entry.sender === myName;
            return (
              <div
                key={entry.id}
                style={{ ...styles.bubble, ...(mine ? styles.mine : null) }}
              >
                {!mine && entry.sender ? <span style={styles.sender}>{entry.sender}</span> : null}
                <span style={styles.body}>{entry.body}</span>
              </div>
            );
          })
        )}
      </div>

      <form style={styles.composer} onSubmit={submit}>
        <input
          className="input"
          value={draft}
          placeholder={t('chat.writeMessage')}
          aria-label={t('chat.writeMessage')}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="primary-button"
          aria-label={t('chat.send')}
          disabled={!draft.trim()}
        >
          <Send size={16} aria-hidden="true" />
        </button>
      </form>
    </aside>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineEnd: 0,
    zIndex: 1,
    width: 'min(22rem, 88vw)',
    pointerEvents: 'auto',
    display: 'grid',
    gridTemplateRows: 'auto 1fr auto',
    gap: '0.5rem',
    padding: '0.9rem',
    background: 'rgba(9, 32, 27, 0.96)',
    borderInlineStart: '1px solid rgba(255, 255, 255, 0.16)',
    color: '#f2fffa',
    overflowY: 'hidden',
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' },
  close: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255, 255, 255, 0.12)',
    color: '#f2fffa',
    cursor: 'pointer',
  },
  list: { display: 'grid', gap: '0.5rem', alignContent: 'start', overflowY: 'auto', minHeight: 0, paddingInlineEnd: 2 },
  empty: { margin: 0, color: '#9fc4b8', fontSize: '0.82rem' },
  bubble: {
    display: 'grid',
    gap: '0.15rem',
    justifySelf: 'start',
    maxWidth: '90%',
    padding: '0.45rem 0.7rem',
    borderRadius: '0.9rem',
    background: 'rgba(255, 255, 255, 0.1)',
    fontSize: '0.85rem',
    overflowWrap: 'anywhere',
  },
  mine: { justifySelf: 'end', background: 'rgba(62, 169, 133, 0.42)' },
  sender: { fontSize: '0.68rem', fontWeight: 800, color: '#bfe6d7' },
  body: { whiteSpace: 'pre-wrap' },
  composer: { display: 'flex', gap: '0.5rem' },
};
