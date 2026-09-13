import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { BellRing, PhoneCall, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { useLang } from '../i18n';
import { useCallContext } from '../context/CallContext';

// ---------------------------------------------------------------------------
// Emergency alert banner — provider side (doctor / department / hospital).
//
// Subscribes to emergency_alerts INSERTs before the initial fetch, dedupes by id
// so an alert landing during the snapshot appears once, and tears the channel
// down on unmount.
// ---------------------------------------------------------------------------

type EmergencyAlert = {
  id: string;
  user_id: string;
  status: string;
  room: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
};

export default function EmergencyAlertBanner() {
  const { user } = useAuth();
  const { t } = useLang();
  const { joinCall } = useCallContext();

  const [alerts, setAlerts] = useState<EmergencyAlert[]>([]);
  const [resolving, setResolving] = useState(false);

  const mounted = useRef(true);

  useEffect(() => {
    if (!user) return;
    mounted.current = true;

    const seen = new Set<string>();
    const add = (row: EmergencyAlert) => {
      if (!row || seen.has(row.id)) return;
      seen.add(row.id);
      setAlerts((previous) => [row, ...previous]);
    };

    const channel = supabase
      .channel('emergency-alerts')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'emergency_alerts' },
        (payload) => {
          const row = payload.new as EmergencyAlert;
          if (row?.status === 'active') add(row);
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'emergency_alerts' },
        (payload) => {
          const row = payload.new as EmergencyAlert;
          if (row?.status && row.status !== 'active') {
            setAlerts((previous) => previous.filter((alert) => alert.id !== row.id));
          }
        },
      )
      .subscribe();

    const load = async () => {
      const { data, error } = await supabase
        .from('emergency_alerts')
        .select('id, user_id, status, room, latitude, longitude, created_at')
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('EMERGENCY ERROR:', error);
        return;
      }
      if (!mounted.current) return;
      for (const row of (data ?? []) as EmergencyAlert[]) add(row);
    };

    void load();

    return () => {
      mounted.current = false;
      void channel.unsubscribe();
    };
  }, [user]);

  const resolve = useCallback(async (id: string) => {
    setResolving(true);
    try {
      const { error } = await supabase
        .from('emergency_alerts')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() })
        .eq('id', id);

      if (error) {
        console.error('EMERGENCY ERROR:', error);
        return;
      }
      setAlerts((previous) => previous.filter((alert) => alert.id !== id));
    } finally {
      if (mounted.current) setResolving(false);
    }
  }, []);

  const alert = alerts[0];
  if (!alert) return null;

  return (
    <div className="emergency-banner" role="alert">
      <div style={styles.copy}>
        <span style={styles.title}>
          <BellRing size={16} aria-hidden="true" />
          {t('emergency.title')}
        </span>
        <span style={styles.meta}>
          {t('emergency.activeBody')}
          {alert.latitude !== null && alert.longitude !== null
            ? ` · ${alert.latitude.toFixed(4)}, ${alert.longitude.toFixed(4)}`
            : ''}
          {alerts.length > 1 ? ` · +${alerts.length - 1}` : ''}
        </span>
      </div>

      <div style={styles.actions}>
        {alert.room ? (
          <button type="button" style={styles.join} onClick={() => void joinCall(alert.room as string, 'emergency')}>
            <PhoneCall size={15} aria-hidden="true" /> {t('emergency.joinLine')}
          </button>
        ) : null}
        <button
          type="button"
          className="ghost-button"
          disabled={resolving}
          onClick={() => void resolve(alert.id)}
        >
          <ShieldCheck size={15} aria-hidden="true" /> {t('emergency.resolve')}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  copy: { display: 'grid', gap: '0.2rem', minWidth: 0 },
  title: { display: 'inline-flex', alignItems: 'center', gap: '0.4rem', color: '#9c3636', fontWeight: 800 },
  meta: { color: '#557b76', fontSize: '0.78rem', lineHeight: 1.45, overflowWrap: 'anywhere' },
  actions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  join: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    paddingBlock: '0.6rem',
    paddingInline: '1rem',
    border: 'none',
    borderRadius: '999px',
    background: 'linear-gradient(120deg, #e0655a, #f0a099)',
    color: '#4a1610',
    fontWeight: 800,
    fontSize: '0.84rem',
    cursor: 'pointer',
  },
};
