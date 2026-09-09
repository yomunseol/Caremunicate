import { useEffect, useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';
import { createDirectConversation } from '../lib/conversations';
import { ChatList } from './ChatList';

type DoctorOption = { user_id: string; username: string | null };

type DashboardChatProps = {
  userId: string;
  role: string; // 'patient' | 'doctor' | 'hospital' | '' (unknown)
  onOpenChat: (conversationId: string) => void;
};

// Role-aware chat hub for the profile dashboard:
//   - patient  -> their doctor conversations + "start a consultation" picker
//   - doctor   -> their patient conversations (the patients they care for)
//   - hospital -> generic conversation list (kept conservative)
// Every list query is RLS-scoped to conversations the user participates in.
export function DashboardChat({ userId, role, onOpenChat }: DashboardChatProps) {
  const isPatient = role === 'patient';
  const isDoctor = role === 'doctor';

  const [doctors, setDoctors] = useState<DoctorOption[]>([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Patients need a doctor directory to start a first consultation. Profiles
  // RLS only exposes other users once a shared conversation exists, so an
  // empty directory simply disables the CTA until a conversation exists.
  useEffect(() => {
    if (!isPatient) return;

    let cancelled = false;

    const loadDoctors = async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, username')
        .eq('role', 'doctor')
        .order('username', { ascending: true })
        .limit(50);

      if (cancelled || error) return;
      setDoctors((data ?? []) as DoctorOption[]);
    };

    void loadDoctors();

    return () => {
      cancelled = true;
    };
  }, [isPatient]);

  const handleStartConsultation = async () => {
    if (!selectedDoctorId || starting) return;

    setStarting(true);
    setStartError(null);
    try {
      // Idempotent: returns the existing thread if the patient already has a
      // conversation with this doctor.
      const conversationId = await createDirectConversation(userId, selectedDoctorId);
      onOpenChat(conversationId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start the conversation.');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div style={styles.wrapper}>
      <div style={styles.headingRow}>
        <div>
          <h3 style={styles.title}>
            {isPatient ? 'Your care conversations' : isDoctor ? 'Your patients' : 'Conversations'}
          </h3>
          <p style={styles.subtitle}>
            {isPatient
              ? 'Message your assigned doctor, or start a new consultation.'
              : isDoctor
                ? 'Chat with the patients you care for. Start a thread from the patient side.'
                : 'Secure threads with the care team you work with.'}
          </p>
        </div>
      </div>

      <ChatList
        onOpenChat={onOpenChat}
        initialFilter={isPatient ? 'doctor' : isDoctor ? 'patient' : 'all'}
      />

      {isPatient ? (
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
            onClick={() => void handleStartConsultation()}
            disabled={!selectedDoctorId || starting || doctors.length === 0}
            style={{
              ...styles.startButton,
              ...(selectedDoctorId && !starting ? styles.startButtonEnabled : null),
            }}
          >
            {starting ? 'Opening…' : 'Message your Doctor'}
          </button>
        </div>
      ) : null}

      {startError ? (
        <p role="alert" style={styles.inlineError}>{startError}</p>
      ) : null}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  headingRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
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
  startButton: {
    border: 'none',
    borderRadius: 999,
    padding: '10px 18px',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    color: '#fff',
    background: 'rgba(0, 0, 0, 0.12)',
    cursor: 'not-allowed',
  },
  startButtonEnabled: {
    background: 'var(--accent, #3ea985)',
    cursor: 'pointer',
  },
  inlineError: {
    margin: 0,
    color: '#c0392b',
    fontSize: 13,
  },
};
