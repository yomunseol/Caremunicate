import { useEffect, useState, type CSSProperties } from 'react';
import { Search } from 'lucide-react';
import { supabase } from '../lib/supabase';

export interface SearchUserResult {
  user_id: string;
  username: string | null;
  role: string;
}

type SearchUsersProps = {
  myRole: string;
  /** Resolve + open/create a thread. Returning a promise lets this component
   *  show per-row busy/error state instead of allowing duplicate clicks. */
  onPick: (user: SearchUserResult) => Promise<void>;
};

const ROLE_LABELS: Record<string, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  hospital: 'Hospital',
};

// Role-scoped directory search:
//   doctor   -> patients
//   patient  -> doctors
//   anything else (hospital) -> patients + doctors
export function SearchUsers({ myRole, onPick }: SearchUsersProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchUserResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setResults([]);
      setSearched(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    // Debounce keystrokes before hitting PostgREST.
    const timer = setTimeout(async () => {
      const targetRoles =
        myRole === 'doctor'
          ? ['patient']
          : myRole === 'patient'
            ? ['doctor']
            : ['patient', 'doctor'];

      // profiles has no email column (email lives on auth.users, which is not
      // readable by the anon/authenticated roles), so we match by username.
      // Strip %/_ so user input can't broaden the ILIKE match.
      const safeQuery = trimmed.replace(/[%_]/g, '');

      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('user_id, username, role')
          .in('role', targetRoles)
          .ilike('username', `%${safeQuery}%`)
          .order('username', { ascending: true })
          .limit(8);

        console.log('Search results:', data);

        if (error) throw error;
        if (cancelled) return;

        setResults((data ?? []) as SearchUserResult[]);
        setSearched(true);
      } catch (err) {
        if (!cancelled) {
          console.error('[chat] user search failed:', err);
          setError(err instanceof Error ? err.message : 'Search failed. Please try again.');
          setSearched(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, myRole]);

  const handlePick = async (user: SearchUserResult) => {
    setBusyId(user.user_id);
    setPickError(null);
    try {
      await onPick(user);
    } catch (err) {
      setPickError(err instanceof Error ? err.message : 'Could not start a conversation.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={styles.wrapper}>
      <div style={styles.searchBox}>
        <Search size={16} style={styles.searchIcon} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            myRole === 'doctor'
              ? 'Search patients by username…'
              : myRole === 'patient'
                ? 'Search doctors by username…'
                : 'Search patients or doctors…'
          }
          aria-label="Search people"
          style={styles.input}
          autoFocus
        />
        {loading ? <span style={styles.spinner} aria-hidden="true" /> : null}
      </div>

      <p style={styles.hint}>
        {myRole === 'doctor'
          ? 'Find a patient to open a conversation.'
          : 'Find a doctor to start a consultation.'}
      </p>

      {error ? <p role="alert" style={styles.inlineError}>{error}</p> : null}
      {pickError ? <p role="alert" style={styles.inlineError}>{pickError}</p> : null}

      {trimmed.length >= 2 && !loading && searched ? (
        results.length === 0 ? (
          <p style={styles.emptyText}>No {myRole === 'patient' ? 'doctors' : 'users'} match “{trimmed}”.</p>
        ) : (
          <ul style={styles.resultList}>
            {results.map((user) => (
              <li key={user.user_id}>
                <button
                  type="button"
                  onClick={() => void handlePick(user)}
                  disabled={busyId !== null}
                  style={styles.resultRow}
                >
                  <span style={styles.avatar}>{user.username?.charAt(0).toUpperCase() ?? '?'}</span>
                  <span style={styles.resultCopy}>
                    <strong style={styles.resultName}>{user.username ?? 'Unnamed user'}</strong>
                    <span style={styles.resultRole}>{ROLE_LABELS[user.role] ?? user.role}</span>
                  </span>
                  <span style={styles.resultAction}>
                    {busyId === user.user_id ? 'Opening…' : 'Chat'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {trimmed.length < 2 ? (
        <p style={styles.emptyText}>Type at least 2 characters to search.</p>
      ) : null}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    flex: 1,
    overflowY: 'auto',
    minHeight: 0,
  },
  searchBox: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  searchIcon: {
    position: 'absolute',
    left: 12,
    color: 'var(--text-muted, #777)',
  },
  input: {
    flex: 1,
    border: '1px solid rgba(0, 0, 0, 0.12)',
    borderRadius: 999,
    padding: '9px 36px',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    background: '#fff',
  },
  spinner: {
    position: 'absolute',
    right: 14,
    width: 12,
    height: 12,
    border: '2px solid rgba(62, 169, 133, 0.3)',
    borderTopColor: 'var(--accent, #3ea985)',
    borderRadius: '50%',
  },
  hint: {
    margin: 0,
    fontSize: 12,
    color: 'var(--text-muted, #777)',
  },
  inlineError: {
    margin: 0,
    fontSize: 13,
    color: '#c0392b',
  },
  emptyText: {
    margin: 0,
    fontSize: 13,
    color: 'var(--text-muted, #777)',
    textAlign: 'center',
    padding: '12px 0',
  },
  resultList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  resultRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
    padding: '8px 10px',
    background: '#fff',
    border: '1px solid rgba(0, 0, 0, 0.06)',
    borderRadius: 12,
    cursor: 'pointer',
  },
  avatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: '50%',
    background: 'rgba(62, 169, 133, 0.15)',
    color: 'var(--accent-strong, #2d7a5f)',
    fontWeight: 700,
    fontSize: 14,
  },
  resultCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    flex: 1,
    minWidth: 0,
  },
  resultName: {
    fontSize: 14,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  resultRole: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'capitalize',
    color: 'var(--accent-strong, #2d7a5f)',
  },
  resultAction: {
    flexShrink: 0,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--accent, #3ea985)',
  },
};
