import { useEffect, useState, type CSSProperties } from 'react';
import { Search } from 'lucide-react';
import { supabase } from '../lib/supabase';

export interface SearchUserResult {
  user_id: string;
  username: string | null;
  role: string;
}

type SearchUsersProps = {
  /** Resolve + open/create a thread. Returning a promise lets this component
   *  show per-row busy/error state instead of allowing duplicate clicks. */
  onPick: (user: SearchUserResult) => Promise<void>;
};

const ROLE_LABELS: Record<string, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  hospital: 'Hospital',
};

// Defensive shape for whatever search_users() returns — it may expose
// user_id or id, and username or email, depending on the SQL definition.
type SearchUserRow = {
  user_id?: string;
  id?: string;
  email?: string | null;
  username?: string | null;
  role?: string | null;
};

const normalizeResult = (row: SearchUserRow): SearchUserResult => ({
  user_id: String(row.user_id ?? row.id ?? ''),
  username: row.username ?? row.email ?? null,
  role: row.role ?? '',
});

// Open search backed by the SECURITY DEFINER SQL function search_users(), which
// safely resolves matching users (by email or name) without exposing profiles
// to direct client-side reads (profiles RLS stays strict). The function's
// return shape is normalized below so the UI does not depend on exact column
// names from the RPC.
export function SearchUsers({ onPick }: SearchUsersProps) {
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

    // Debounce keystrokes before hitting the RPC.
    const timer = setTimeout(async () => {
      // Strip %/_ so user input can't broaden the ILIKE inside search_users().
      const safeQuery = trimmed.replace(/[%_]/g, '');

      try {
        const { data, error } = await supabase.rpc('search_users', {
          search_query: safeQuery,
        });

        console.log('SEARCH:', data, error);

        if (error) throw error;
        if (cancelled) return;

        setResults(
          ((data ?? []) as SearchUserRow[])
            .map(normalizeResult)
            .filter((result) => Boolean(result.user_id)),
        );
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
  }, [trimmed]);

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
          placeholder="Enter the person's email..."
          aria-label="Search users by email"
          style={styles.input}
          autoFocus
        />
        {loading ? <span style={styles.spinner} aria-hidden="true" /> : null}
      </div>

      <p style={styles.hint}>Search any patient or doctor by email.</p>

      {error ? <p role="alert" style={styles.inlineError}>{error}</p> : null}
      {pickError ? <p role="alert" style={styles.inlineError}>{pickError}</p> : null}

      {trimmed.length >= 2 && !loading && searched ? (
        results.length === 0 ? (
          <p style={styles.emptyText}>No users match "{trimmed}".</p>
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
