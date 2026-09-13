import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { PhoneOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { useLang } from '../i18n';
import { useCallContext } from '../context/CallContext';

// ---------------------------------------------------------------------------
// Emergency line — patient side.
//
// States: idle → confirming → connecting → active → ended (→ idle). Every async
// step is guarded by a mounted ref and the flow always settles, so the card can
// never get stuck in "Connecting…".
//
// Geolocation is best-effort: a denial is skipped silently and the alert still
// goes out. The room is em-{user_id} so the patient's own providers land in the
// same call.
// ---------------------------------------------------------------------------

type EmergencyState = 'idle' | 'confirming' | 'connecting' | 'active' | 'ended';

const roomFor = (userId: string): string => `em-${userId}`;

export default function EmergencyCard() {
  const { user } = useAuth();
  const { t } = useLang();
  const { startCall, endCall } = useCallContext();

  const [state, setState] = useState<EmergencyState>('idle');
  const [alertId, setAlertId] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Resolves null when unsupported, timed out, or denied — never rejects. */
  const getPosition = useCallback(
    () =>
      new Promise<{ lat: number; lon: number } | null>((resolve) => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
          resolve(null);
          return;
        }

        navigator.geolocation.getCurrentPosition(
          (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
          () => resolve(null), // permission denied → skip silently
          { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 },
        );
      }),
    [],
  );

  const startLine = useCallback(async () => {
    if (!user) return;

    setState('connecting');
    const room = roomFor(user.id);

    try {
      const coords = await getPosition();
      if (!mounted.current) return;

      const { data, error } = await supabase
        .from('emergency_alerts')
        .insert({
          user_id: user.id,
          status: 'active',
          latitude: coords?.lat ?? null,
          longitude: coords?.lon ?? null,
          room,
        })
        .select()
        .single();

      if (error) console.error('EMERGENCY ERROR:', error);
      if (!mounted.current) return;

      if (data?.id) setAlertId(String(data.id));
      await startCall(room, 'emergency');
      setState('active');
    } catch (error) {
      console.error('EMERGENCY ERROR:', error);
      if (!mounted.current) return;
      // The call is the point of the feature — open the room even if the row failed.
      await startCall(room, 'emergency');
      setState('active');
    }
  }, [user, getPosition]);

  const endLine = useCallback(async () => {
    endCall();
    setState('ended');

    if (alertId) {
      const { error } = await supabase
        .from('emergency_alerts')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() })
        .eq('id', alertId)
        .eq('user_id', user?.id ?? '');

      if (error) console.error('EMERGENCY_ERROR:', error);
    }

    setAlertId(null);
    if (mounted.current) setState('idle');
  }, [alertId, user]);

  const room = user ? roomFor(user.id) : '';
  const isActive = state === 'active';

  return (
    <div className="panel">
      <div style={styles.head}>
        <span className="eyebrow" style={{ margin: 0 }}>{t('emergency.title')}</span>
        {isActive ? <span className="emergency-pulse" aria-hidden="true" /> : null}
      </div>

      {isActive ? (
        <>
          <p style={styles.activeText}>{t('emergency.activeBody')}</p>
          <button type="button" className="ghost-button" style={styles.endButton} onClick={() => void endLine()}>
            <PhoneOff size={16} aria-hidden="true" /> {t('emergency.end')}
          </button>
        </>
      ) : (
        <>
          <p style={styles.muted}>{t('emergency.subtitle')}</p>
          <button
            type="button"
            style={styles.connectButton}
            disabled={state === 'connecting'}
            onClick={() => setState('confirming')}
          >
            {state === 'connecting' ? t('emergency.connecting') : t('emergency.connect')}
          </button>
        </>
      )}

      {state === 'confirming' ? (
        <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label={t('emergency.confirmTitle')}>
          <div style={styles.modal}>
            <strong>{t('emergency.confirmTitle')}</strong>
            <p style={styles.muted}>{t('emergency.confirmBody')}</p>
            <div style={styles.modalActions}>
              <button type="button" className="ghost-button" onClick={() => setState('idle')}>
                {t('common.cancel')}
              </button>
              <button type="button" style={styles.connectButton} onClick={() => void startLine()}>
                {t('emergency.connect')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' },
  muted: { margin: 0, color: '#557b76', fontSize: '0.86rem', lineHeight: 1.6 },
  activeText: { margin: 0, color: '#9c3636', fontSize: '0.88rem', fontWeight: 700, lineHeight: 1.5 },
  connectButton: {
    width: '100%',
    marginTop: '0.9rem',
    paddingBlock: '0.95rem',
    paddingInline: '1rem',
    border: 'none',
    borderRadius: '999px',
    background: 'linear-gradient(120deg, #e0655a, #f0a099)',
    color: '#4a1610',
    fontWeight: 800,
    fontSize: '1rem',
    cursor: 'pointer',
  },
  endButton: { marginTop: '0.9rem', width: '100%', justifyContent: 'center', gap: '0.5rem' },
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 95,
    display: 'grid',
    placeItems: 'center',
    padding: '1rem',
    background: 'rgba(6, 26, 22, 0.55)',
  },
  modal: {
    display: 'grid',
    gap: '0.6rem',
    width: 'min(30rem, 100%)',
    padding: '1.15rem',
    borderRadius: '1.15rem',
    background: '#f7fdf9',
    border: '1px solid rgba(224, 101, 90, 0.35)',
    boxShadow: '0 28px 64px rgba(6, 26, 22, 0.35)',
  },
  modalActions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
};
