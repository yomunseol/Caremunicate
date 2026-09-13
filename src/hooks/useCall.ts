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

// Capture + sender ceilings. 720p30 is the top rung; the adaptive ladder below
// steps down from here.
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
const MAX_FPS = 30;
const MAX_BITRATE = 900_000;

/** 720 → 480 → 360 → (video off). */
const LADDER: Array<{ width: number; height: number }> = [
  { width: 1280, height: 720 },
  { width: 854, height: 480 },
  { width: 640, height: 360 },
];

const STATS_INTERVAL_MS = 5000;
const RECOVER_AFTER_MS = 15_000;

export type CallStats = {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  limit: string;
};

/** H.264 first (better hardware support), VP8 as the fallback. */
const CODEC_ORDER = ['video/H264', 'video/VP8', 'video/VP9'];

const preferH264 = (pc: RTCPeerConnection) => {
  if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
  const capabilities = RTCRtpSender.getCapabilities('video');
  if (!capabilities) return;

  const ordered = [...capabilities.codecs].sort((a, b) => {
    const ai = CODEC_ORDER.indexOf(a.mimeType);
    const bi = CODEC_ORDER.indexOf(b.mimeType);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  for (const transceiver of pc.getTransceivers()) {
    try {
      transceiver.setCodecPreferences(ordered);
    } catch (error) {
      console.error('CALL ERROR:', error);
    }
  }
};

/** Applies the sender ceilings to every video sender on this connection. */
const tuneSenders = async (pc: RTCPeerConnection) => {
  preferH264(pc);

  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      params.degradationPreference = 'balanced';
      const encodings = params.encodings.length > 0 ? params.encodings : [{}];
      params.encodings = encodings.map((encoding) => ({
        ...encoding,
        maxBitrate: MAX_BITRATE,
        maxFramerate: MAX_FPS,
      }));
      await sender.setParameters(params);
    } catch (error) {
      console.error('CALL ERROR:', error);
    }
  }
};

const ladderIndex = (track: MediaStreamTrack | null): number => {
  const width = track?.getSettings().width ?? MAX_WIDTH;
  const index = LADDER.findIndex((step) => step.width === width);
  return index === -1 ? 0 : index;
};

/** One rung down; the bottom rung turns video off entirely (audio continues). */
const stepDown = async (track: MediaStreamTrack | null) => {
  if (!track) return;
  const index = ladderIndex(track);
  if (index >= LADDER.length - 1) {
    track.enabled = false;
    return;
  }
  const next = LADDER[index + 1];
  try {
    await track.applyConstraints({
      width: { ideal: next.width, max: next.width },
      height: { ideal: next.height, max: next.height },
    });
  } catch (error) {
    console.error('CALL ERROR:', error);
  }
};

/** One rung up, re-enabling video if it was switched off. */
const stepUp = async (track: MediaStreamTrack | null) => {
  if (!track) return;
  if (!track.enabled) {
    track.enabled = true;
    return;
  }
  const index = ladderIndex(track);
  if (index <= 0) return;
  const next = LADDER[index - 1];
  try {
    await track.applyConstraints({
      width: { ideal: next.width, max: next.width },
      height: { ideal: next.height, max: next.height },
    });
  } catch (error) {
    console.error('CALL ERROR:', error);
  }
};

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
  stats: CallStats | null;
  showStats: boolean;
  toggleStats: () => void;
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
  const [stats, setStats] = useState<CallStats | null>(null);
  const [showStats, setShowStats] = useState(false);

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
  const lastBytes = useRef(0);

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
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: video
          ? {
              width: { ideal: MAX_WIDTH, max: MAX_WIDTH },
              height: { ideal: MAX_HEIGHT, max: MAX_HEIGHT },
              frameRate: { ideal: MAX_FPS, max: MAX_FPS },
            }
          : false,
      });
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
      void tuneSenders(pc);

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

  // Poll outbound video stats every 5s: feeds the demo chip and drives the
  // adaptive ladder (bandwidth-limited → step down; healthy for 15s → step up).
  useEffect(() => {
    if (status !== 'active' && status !== 'connecting') return;

    let cancelled = false;
    let healthySince: number | null = null;

    const poll = async () => {
      const peer = [...peers.current.values()][0];
      const sender = peer?.pc.getSenders().find((item) => item.track?.kind === 'video');
      if (!sender || !sender.track) return;

      let width = 0;
      let height = 0;
      let fps = 0;
      let bytes = 0;
      let limit = '';

      try {
        const report = await sender.getStats();
        report.forEach((entry) => {
          const record = entry as RTCStats & {
            kind?: string;
            framesPerSecond?: number;
            bytesSent?: number;
            qualityLimitationReason?: string;
            frameWidth?: number;
            frameHeight?: number;
          };

          if (record.type === 'outbound-rtp' && record.kind === 'video') {
            fps = Number(record.framesPerSecond ?? 0);
            bytes = Number(record.bytesSent ?? 0);
            limit = String(record.qualityLimitationReason ?? '');
          }
          if (record.type === 'media-source') {
            if (record.frameWidth) width = Number(record.frameWidth);
            if (record.frameHeight) height = Number(record.frameHeight);
          }
        });
      } catch (error) {
        console.error('CALL ERROR:', error);
        return;
      }

      if (cancelled) return;

      const kbps = Math.max(0, Math.round(((bytes - lastBytes.current) * 8) / 1000 / (STATS_INTERVAL_MS / 1000)));
      lastBytes.current = bytes;
      setStats({ width, height, fps, kbps, limit });

      const track = sender.track;

      if (limit === 'bandwidth') {
        healthySince = null;
        await stepDown(track);
        return;
      }

      if (healthySince === null) {
        healthySince = Date.now();
      } else if (Date.now() - healthySince > RECOVER_AFTER_MS) {
        healthySince = null;
        await stepUp(track);
      }
    };

    const id = window.setInterval(() => void poll(), STATS_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [status]);

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
    stats,
    showStats,
    toggleStats: () => setShowStats((previous) => !previous),
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
