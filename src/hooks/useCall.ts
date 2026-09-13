import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

// ---------------------------------------------------------------------------
// First-party calling engine over Supabase Realtime broadcast.
//
// Signaling: broadcast channel `call:{roomId}` with events
//   invite | offer | answer | ice | decline | leave | heartbeat
// Media:     RTCPeerConnection, perfect-negotiation pattern, public STUN only
//            (no TURN — symmetric-NAT calls may fail; that is a known limit).
// Topology:  full mesh, capped at MAX_MESH participants.
//
// NOTE: WebRTC media cannot be exercised in CI — verify with two real browsers.
// ---------------------------------------------------------------------------

export type CallKind = 'video' | 'emergency';
export type CallQuality = 'good' | 'fair' | 'poor';
export type CallStatus =
  | 'idle'
  | 'incoming'
  | 'outgoing'
  | 'connecting'
  | 'active'
  | 'reconnecting'
  | 'ended';

export type CallPeer = { id: string; stream: MediaStream | null };

export type IncomingCall = { roomId: string; from: string; kind: CallKind };

/** Deterministic 1:1 room so both sides land in the same channel. */
export const peerRoom = (a: string, b: string): string =>
  `dm-${[a, b].sort().join('-')}`;

/** Emergency room is owned by the patient and named after them. */
export const emergencyRoomFor = (userId: string): string => `em-${userId}`;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

const MAX_MESH = 4;
const HEARTBEAT_MS = 10_000;
const PEER_TIMEOUT_MS = 35_000;
const ANSWER_TIMEOUT_MS = 12_000;
const EMERGENCY_RETRIES = 3;

type SignalPayload = {
  from: string;
  to?: string;
  kind?: CallKind;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  audioOnly?: boolean;
};

type Peer = {
  id: string;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  lastSeen: number;
  iceRestarted: boolean;
  audioRetried: boolean;
};

export type UseCallResult = {
  status: CallStatus;
  kind: CallKind;
  roomId: string | null;
  incoming: IncomingCall | null;
  peers: CallPeer[];
  localStream: MediaStream | null;
  audioOnly: boolean;
  muted: boolean;
  cameraOff: boolean;
  quality: CallQuality;
  notice: string | null;
  /** Pass a peer user id for 'video', or a room id for 'emergency'. */
  startCall: (target: string, kind?: CallKind) => Promise<void>;
  /** Join an existing room (accept an invite, or a provider joining a line). */
  joinCall: (roomId: string, kind?: CallKind) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  endCall: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  clearNotice: () => void;
};

export function useCall(currentUserId: string | null | undefined): UseCallResult {
  const me = currentUserId ?? '';

  const [status, setStatus] = useState<CallStatus>('idle');
  const [kind, setKind] = useState<CallKind>('video');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [quality, setQuality] = useState<CallQuality>('good');
  const [notice, setNotice] = useState<string | null>(null);

  const peers = useRef(new Map<string, Peer>());
  const channel = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const room = useRef<string | null>(null);
  const kindRef = useRef<CallKind>('video');
  const audioOnlyRef = useRef(false);
  const heartbeat = useRef<number | null>(null);
  const sweeper = useRef<number | null>(null);
  const answerTimer = useRef<number | null>(null);
  const retryCount = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = useCallback((event: string, payload: Partial<SignalPayload>) => {
    const ch = channel.current;
    if (!ch || !me) return;
    void ch.send({ type: 'broadcast', event, payload: { from: me, ...payload } });
  }, [me]);

  // ---- media ---------------------------------------------------------------
  const getMedia = useCallback(async (video: boolean): Promise<MediaStream | null> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video });
    } catch (error) {
      console.error('CALL ERROR:', error);
      return null;
    }
  }, []);

  // ---- peer plumbing (perfect negotiation) --------------------------------
  const closePeer = useCallback((id: string) => {
    const peer = peers.current.get(id);
    if (!peer) return;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch {
      /* already closed */
    }
    peers.current.delete(id);
  }, []);

  const teardown = useCallback(() => {
    for (const id of [...peers.current.keys()]) closePeer(id);
    if (heartbeat.current) window.clearInterval(heartbeat.current);
    if (sweeper.current) window.clearInterval(sweeper.current);
    if (answerTimer.current) window.clearTimeout(answerTimer.current);
    heartbeat.current = null;
    sweeper.current = null;
    answerTimer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (channel.current) void supabase.removeChannel(channel.current);
    channel.current = null;
    room.current = null;
  }, [closePeer]);

  const ensurePeer = useCallback(
    (peerId: string): Peer => {
      const existing = peers.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const peer: Peer = {
        id: peerId,
        pc,
        stream: null,
        // Deterministic politeness: the lexicographically smaller id is polite.
        polite: me < peerId,
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        lastSeen: Date.now(),
        iceRestarted: false,
        audioRetried: false,
      };
      peers.current.set(peerId, peer);
      setPeerIds([...peers.current.keys()]);

      for (const track of stream.current?.getTracks() ?? []) {
        pc.addTrack(track, stream.current as MediaStream);
      }

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) send('ice', { to: peerId, candidate: candidate.toJSON(), kind: kindRef.current });
      };

      pc.ontrack = ({ streams: remote }) => {
        const [first] = remote;
        if (!first) return;
        peer.stream = first;
        setPeerIds([...peers.current.keys()]);
      };

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          send('offer', { to: peerId, description: pc.localDescription ?? undefined, kind: kindRef.current });
        } catch (error) {
          console.error('CALL ERROR:', error);
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          peer.iceRestarted = false;
          peer.audioRetried = false;
          retryCount.current = 0;
          if (answerTimer.current) window.clearTimeout(answerTimer.current);
          setStatus('active');
          return;
        }

        if (state !== 'failed') return;
        console.error('CALL ERROR: connection failed for', peerId);

        // 1) one silent ICE restart
        if (!peer.iceRestarted) {
          peer.iceRestarted = true;
          void (async () => {
            try {
              await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
              send('offer', { to: peerId, description: pc.localDescription ?? undefined, kind: kindRef.current });
            } catch (error) {
              console.error('CALL ERROR:', error);
            }
          })();
          return;
        }

        // 2) drop to audio only
        if (!peer.audioRetried && !audioOnlyRef.current) {
          peer.audioRetried = true;
          audioOnlyRef.current = true;
          setAudioOnly(true);
          void (async () => {
            const next = await getMedia(false);
            if (!next) return;
            stream.current?.getTracks().forEach((track) => track.stop());
            stream.current = next;
            setLocalStream(next);
            const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
            const audioTrack = next.getAudioTracks()[0];
            if (sender && audioTrack) await sender.replaceTrack(audioTrack);
            for (const other of peers.current.values()) {
              for (const videoSender of other.pc.getSenders().filter((s) => s.track?.kind === 'video')) {
                other.pc.removeTrack(videoSender);
              }
            }
          })();
          return;
        }

        // 3) give up and suggest continuing in chat
        setNotice('continue-in-chat');
        setStatus('ended');
      };

      return peer;
    },
    [me, send, getMedia],
  );

  const applyDescription = useCallback(
    async (from: string, description: RTCSessionDescriptionInit) => {
      const peer = ensurePeer(from);
      const { pc } = peer;

      const readyForOffer =
        !peer.makingOffer && (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
      const offerCollision = description.type === 'offer' && !readyForOffer;

      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;

      peer.isSettingRemoteAnswerPending = description.type === 'answer';
      await pc.setRemoteDescription(description);
      peer.isSettingRemoteAnswerPending = false;

      if (description.type === 'offer') {
        await pc.setLocalDescription();
        send('answer', { to: from, description: pc.localDescription ?? undefined, kind: kindRef.current });
      }
    },
    [ensurePeer, send],
  );

  // ---- channel -------------------------------------------------------------
  const attachChannel = useCallback(
    (targetRoom: string) => {
      const ch = supabase.channel(`call:${targetRoom}`, {
        config: { broadcast: { self: false } },
      });

      ch.on('broadcast', { event: 'invite' }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        if (peers.current.size >= MAX_MESH) return;

        if (room.current && room.current === targetRoom && status !== 'idle') {
          // Already in this call — treat as a mesh join.
          send('heartbeat', { to: data.from, kind: kindRef.current });
          return;
        }

        kindRef.current = data.kind ?? 'video';
        setKind(data.kind ?? 'video');
        setIncoming({ roomId: targetRoom, from: data.from, kind: data.kind ?? 'video' });
        setStatus('incoming');
      });

      ch.on('broadcast', { event: 'offer' }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me || !data.description) return;
        peerOf(data.from).lastSeen = Date.now();
        void applyDescription(data.from, data.description).catch((error) => console.error('CALL ERROR:', error));
      });

      ch.on('broadcast', { event: 'answer' }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me || !data.description) return;
        peerOf(data.from).lastSeen = Date.now();
        void applyDescription(data.from, data.description).catch((error) => console.error('CALL ERROR:', error));
      });

      ch.on('broadcast', { event: 'ice' }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me || !data.candidate) return;
        const peer = peerOf(data.from);
        peer.lastSeen = Date.now();
        void peer.pc.addIceCandidate(data.candidate).catch((error) => {
          if (!peer.ignoreOffer) console.error('CALL ERROR:', error);
        });
      });

      ch.on('broadcast', { event: 'heartbeat' }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        const peer = peers.current.get(data.from);
        if (peer) peer.lastSeen = Date.now();
      });

      ch.on('broadcast', { event: 'decline' }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        setNotice('declined');
        teardown();
        setStatus('ended');
      });

      ch.on('broadcast', { event: 'leave' }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        closePeer(data.from);
        setPeerIds([...peers.current.keys()]);
        if (peers.current.size === 0) {
          teardown();
          setStatus('ended');
        }
      });

      ch.subscribe();
      channel.current = ch;

      // Peer liveness + our own heartbeat.
      sweeper.current = window.setInterval(() => {
        const now = Date.now();
        for (const [id, peer] of peers.current) {
          if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
            console.error('CALL ERROR: peer timed out', id);
            send('leave', { to: id, kind: kindRef.current });
            closePeer(id);
          }
        }
        setPeerIds([...peers.current.keys()]);
      }, HEARTBEAT_MS);

      heartbeat.current = window.setInterval(() => {
        send('heartbeat', { kind: kindRef.current });
        let pending = 0;
        for (const peer of peers.current.values()) {
          pending += Number(peer.pc.connectionState !== 'connected');
        }
        setQuality(pending === 0 ? 'good' : pending === 1 ? 'fair' : 'poor');
      }, HEARTBEAT_MS);
    },
    // peerOf is a stable helper below; status is read for the invite guard only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me, send, applyDescription, closePeer, teardown],
  );

  /** Lazily creates the peer entry for an inbound signal. */
  const peerOf = useCallback(
    (id: string): Peer => ensurePeer(id),
    [ensurePeer],
  );

  // ---- actions -------------------------------------------------------------
  const joinCall = useCallback(
    async (targetRoom: string, nextKind: CallKind = 'video') => {
      if (!me) return;
      if (room.current === targetRoom) return;

      retryCount.current = 0;
      kindRef.current = nextKind;
      audioOnlyRef.current = false;
      setKind(nextKind);
      setAudioOnly(false);
      setNotice(null);
      setIncoming(null);
      setStatus('connecting');
      room.current = targetRoom;
      setRoomId(targetRoom);

      const media = await getMedia(nextKind === 'video');
      if (!alive.current) return;

      stream.current = media;
      setLocalStream(media);

      attachChannel(targetRoom);

      // Invite everyone already in the room; mesh peers answer with offers.
      send('invite', { kind: nextKind, to: undefined });
    },
    [me, getMedia, attachChannel, send],
  );

  const startCall = useCallback(
    async (target: string, nextKind: CallKind = 'video') => {
      if (!me || !target) return;
      const targetRoom = nextKind === 'emergency' ? target : peerRoom(me, target);
      await joinCall(targetRoom, nextKind);

      if (nextKind !== 'emergency') return;

      // Emergency: re-invite with backoff, then fall back to a persistent alert.
      const attempt = (n: number) => {
        if (!alive.current || room.current !== targetRoom) return;
        if (peers.current.size > 0) return;

        send('invite', { kind: 'emergency' });
        if (n >= EMERGENCY_RETRIES) {
          void supabase
            .from('emergency_alerts')
            .insert({ user_id: me, status: 'active', room: targetRoom })
            .then(({ error }) => {
              if (error) console.error('CALL ERROR:', error);
            });
          return;
        }
        answerTimer.current = window.setTimeout(() => attempt(n + 1), 3000 * 2 ** (n - 1));
      };
      answerTimer.current = window.setTimeout(() => attempt(1), ANSWER_TIMEOUT_MS);
    },
    [me, joinCall, send],
  );

  const acceptCall = useCallback(async () => {
    if (!incoming) return;
    await joinCall(incoming.roomId, incoming.kind);
  }, [incoming, joinCall]);

  const declineCall = useCallback(() => {
    if (incoming) send('decline', { to: incoming.from, kind: incoming.kind });
    teardown();
    setIncoming(null);
    setStatus('idle');
  }, [incoming, send, teardown]);

  const endCall = useCallback(() => {
    send('leave', { kind: kindRef.current });
    teardown();
    setIncoming(null);
    setPeerIds([]);
    setLocalStream(null);
    setStatus('idle');
    setAudioOnly(false);
    setMuted(false);
    setCameraOff(false);
  }, [send, teardown]);

  const toggleMic = useCallback(() => {
    const track = stream.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOff(!track.enabled);
  }, []);

  // Never leave a session behind on unmount.
  useEffect(() => () => teardown(), [teardown]);

  const list = useMemo<CallPeer[]>(
    () => peerIds.map((id) => ({ id, stream: peers.current.get(id)?.stream ?? null })),
    [peerIds],
  );

  return {
    status,
    kind,
    roomId,
    incoming,
    peers: list,
    localStream,
    audioOnly,
    muted,
    cameraOff,
    quality,
    notice,
    startCall,
    joinCall,
    acceptCall,
    declineCall,
    endCall,
    toggleMic,
    toggleCamera,
    clearNotice: () => setNotice(null),
  };
}
