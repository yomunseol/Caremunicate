import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { normalizeCode, setRoomStatus } from '../lib/callRooms';

// ---------------------------------------------------------------------------
// First-party calling engine over Supabase Realtime broadcast.
//
// Signaling: broadcast channel `call:{normalizedCode}` with events
//   call:join | call:offer | call:answer | call:ice | call:leave
//   call:decline | call:heartbeat | call:ended
// Media:     RTCPeerConnection, perfect-negotiation pattern, public STUN only
//            (no TURN — symmetric-NAT calls may fail; that is a known limit).
// Topology:  full mesh, capped at MAX_MESH participants.
//
// Once every peer's RTCDataChannel is open the Supabase channel is released
// (heartbeats then ride the data channel); it is only re-subscribed when a peer
// connection drops and comes back.
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

export type IncomingCall = { roomId: string; from: string; kind: CallKind; name?: string };

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
/** DataChannel liveness ping — the only heartbeat once signaling is released. */
const DC_PING_MS = 3_000;

/** How long an emoji reaction floats over a tile before it retires. */
const REACTION_MS = 2_600;

/** Broadcast event names. Every room signal carries the `call:` namespace. */
const EV = {
  join: 'call:join',
  offer: 'call:offer',
  answer: 'call:answer',
  ice: 'call:ice',
  leave: 'call:leave',
  decline: 'call:decline',
  heartbeat: 'call:heartbeat',
  ended: 'call:ended',
  lobby: 'call:lobby',
  admit: 'call:admit',
  deny: 'call:deny',
} as const;

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

/** Audio we always ask for — all three processing flags on. */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const MIC_KEY = 'caremunicate:mic';
const CAM_KEY = 'caremunicate:cam';

const readStoredDevice = (which: 'mic' | 'cam'): string | null => {
  try {
    return window.localStorage.getItem(which === 'mic' ? MIC_KEY : CAM_KEY);
  } catch {
    return null;
  }
};

const storeDevice = (which: 'mic' | 'cam', deviceId: string | null): void => {
  try {
    if (deviceId) window.localStorage.setItem(which === 'mic' ? MIC_KEY : CAM_KEY, deviceId);
    else window.localStorage.removeItem(which === 'mic' ? MIC_KEY : CAM_KEY);
  } catch {
    /* storage blocked — the in-memory selection still applies */
  }
};

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
  /** Target of a lobby admit/deny. */
  for?: string;
  name?: string;
  kind?: CallKind;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  audioOnly?: boolean;
};

type Peer = {
  id: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  dcOpen: boolean;
  ping: number | null;
  stream: MediaStream | null;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  lastSeen: number;
  iceRestarted: boolean;
  audioRetried: boolean;
};

export type JoinOptions = {
  /** True when the current user created the room (enables End for all). */
  isHost?: boolean;
  /** The human-readable room code, when joining via /call/{code}. */
  code?: string;
  /** True when the room's waiting room is enabled (guests are held in a lobby). */
  lobby?: boolean;
};

export type PeerConnState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

/** What we know about a remote participant, including what they broadcast. */
export type PeerInfo = {
  name: string;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  hand: boolean;
  host: boolean;
  connection: PeerConnState;
};

/** A transient emoji burst, rendered over the sender's tile. */
export type Reaction = { id: string; emoji: string; from: string; self: boolean };

/** Someone waiting in the lobby to be admitted (host side). */
export type LobbyGuest = { id: string; name: string };

/** One row of the participants panel (self included). */
export type Participant = {
  id: string;
  name: string;
  self: boolean;
  host: boolean;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  hand: boolean;
  connection: PeerConnState;
};

export type ViewMode = 'speaker' | 'gallery';

/** Pre-connection UI phases (no peer connection exists yet). */
export type Stage = 'idle' | 'prejoin' | 'lobby';

export type DeviceOption = { deviceId: string; label: string };

export type OpenRoomOptions = {
  isHost?: boolean;
  code?: string;
  lobby?: boolean;
};

export type UseCallResult = {
  status: CallStatus;
  kind: CallKind;
  roomId: string | null;
  /** Set only for code rooms (/call/{code}); drives the stage code chip. */
  roomCode: string | null;
  isHost: boolean;
  /** Display name of the other party when known — drives the CallLayer top bar. */
  peerName: string | null;
  /** Epoch ms the call first went active — drives the CallLayer timer. */
  connectedAt: number | null;
  incoming: IncomingCall | null;
  peers: CallPeer[];
  /** Per-peer name / mic / cam / sharing / hand / connection, keyed by peer id. */
  peerInfo: Record<string, PeerInfo>;
  localStream: MediaStream | null;
  /** The display-capture stream while this user is sharing. */
  shareStream: MediaStream | null;
  audioOnly: boolean;
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  handRaised: boolean;
  reactions: Reaction[];
  quality: CallQuality;
  notice: string | null;
  stats: CallStats | null;
  showStats: boolean;
  toggleStats: () => void;
  /** Pre-connection phases: the green room (prejoin) and the waiting room (lobby). */
  stage: Stage;
  lobby: LobbyGuest[];
  lobbyEnabled: boolean;
  devices: { mics: DeviceOption[]; cams: DeviceOption[] };
  micId: string | null;
  camId: string | null;
  /** Self first, then remotes — feeds the participants panel. */
  participants: Participant[];
  /** Pass a peer user id for 'video', or a room id for 'emergency'. */
  startCall: (target: string, kind?: CallKind, peerName?: string) => Promise<void>;
  /** Join an existing room (accept an invite, or a provider joining a line). */
  joinCall: (roomId: string, kind?: CallKind, options?: JoinOptions) => Promise<void>;
  /** Open a room into the green room (or lobby) WITHOUT connecting any media. */
  openRoom: (roomId: string, options?: OpenRoomOptions) => Promise<void>;
  /** Leave the green room and actually connect. */
  commitJoin: () => Promise<void>;
  /** Leave the green room / lobby without connecting. */
  cancelPrejoin: () => void;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  endCall: () => void;
  /** Host only: broadcast call:ended, mark the room ended, and leave. */
  endForAll: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleHand: () => void;
  /** Host only: lower another participant's raised hand. */
  lowerPeerHand: (peerId: string) => void;
  startShare: () => Promise<void>;
  stopShare: () => Promise<void>;
  sendReaction: (emoji: string) => void;
  refreshDevices: () => Promise<void>;
  selectMic: (deviceId: string) => Promise<void>;
  selectCamera: (deviceId: string) => Promise<void>;
  /** Host only: admit or deny someone waiting in the lobby. */
  admitGuest: (id: string) => void;
  denyGuest: (id: string) => void;
  notify: (messageKey: string) => void;
  clearNotice: () => void;
};

export function useCall(
  currentUserId: string | null | undefined,
  currentUserName?: string | null,
): UseCallResult {
  const me = currentUserId ?? '';
  const myName = currentUserName ?? '';

  const [status, setStatus] = useState<CallStatus>('idle');
  const [kind, setKind] = useState<CallKind>('video');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [peerName, setPeerName] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
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
  const [peerInfo, setPeerInfo] = useState<Record<string, PeerInfo>>({});
  const [shareStream, setShareStream] = useState<MediaStream | null>(null);
  const [sharing, setSharing] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [stage, setStage] = useState<Stage>('idle');
  const [lobby, setLobby] = useState<LobbyGuest[]>([]);
  const [lobbyEnabled, setLobbyEnabled] = useState(false);
  const [mics, setMics] = useState<DeviceOption[]>([]);
  const [cams, setCams] = useState<DeviceOption[]>([]);
  const [micId, setMicId] = useState<string | null>(() => readStoredDevice('mic'));
  const [camId, setCamId] = useState<string | null>(() => readStoredDevice('cam'));

  const peers = useRef(new Map<string, Peer>());
  const channel = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const channelReleased = useRef(false);
  const reattachRef = useRef<() => void>(() => {});
  const promoted = useRef(false);
  const hostRef = useRef(false);
  /** Mirrors of the state below, readable from stable callbacks. */
  const mutedRef = useRef(false);
  const cameraOffRef = useRef(false);
  const handRef = useRef(false);
  const sharingRef = useRef(false);
  const stageRef = useRef<Stage>('idle');
  const micIdRef = useRef<string | null>(null);
  const camIdRef = useRef<string | null>(null);
  /** Green-room preview stream (no peer connection yet). */
  const preview = useRef<MediaStream | null>(null);
  /** Our own camera track, kept so screen share can be undone. */
  const ownVideoTrack = useRef<MediaStreamTrack | null>(null);
  /** Mutable handle on the live display-capture stream. */
  const shareRef = useRef<MediaStream | null>(null);
  const pending = useRef<{ key: string; options: OpenRoomOptions } | null>(null);
  /** Set after openRoom is defined; the lobby's call:admit handler calls it. */
  const enterPrejoinRef = useRef<() => Promise<void>>(async () => {});
  /** Set after stopShare is defined; the display-track 'ended' handler uses it. */
  const stopShareRef = useRef<() => Promise<void>>(async () => {});
  const reactionTimers = useRef<number[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const room = useRef<string | null>(null);
  /** The active code room, readable from stable callbacks. */
  const roomCodeRef = useRef<string | null>(null);
  const kindRef = useRef<CallKind>('video');
  const audioOnlyRef = useRef(false);
  const statusRef = useRef<CallStatus>('idle');
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

  // The status echoed into closure-created channel handlers (which are not
  // rebuilt when status changes).
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // The timer starts on first connect and survives a reconnect blip.
  useEffect(() => {
    if (status === 'active') {
      setConnectedAt((previous) => previous ?? Date.now());
    } else if (status === 'idle' || status === 'ended') {
      setConnectedAt(null);
    }
  }, [status]);

  // Ref mirrors, so stable callbacks (DataChannel handlers) read current state.
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { cameraOffRef.current = cameraOff; }, [cameraOff]);
  useEffect(() => { handRef.current = handRaised; }, [handRaised]);
  useEffect(() => { sharingRef.current = sharing; }, [sharing]);
  useEffect(() => { stageRef.current = stage; }, [stage]);
  useEffect(() => { micIdRef.current = micId; }, [micId]);
  useEffect(() => { camIdRef.current = camId; }, [camId]);

  const send = useCallback((event: string, payload: Partial<SignalPayload>) => {
    const ch = channel.current;
    if (!ch || !me) return;
    void ch.send({ type: 'broadcast', event, payload: { from: me, ...payload } });
  }, [me]);

  // ---- media ---------------------------------------------------------------
  const getMedia = useCallback(
    async (
      video: boolean,
      deviceIds?: { micId?: string | null; camId?: string | null },
    ): Promise<MediaStream | null> => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;

      const mic = deviceIds?.micId ?? micIdRef.current;
      const cam = deviceIds?.camId ?? camIdRef.current;
      const videoConstraints = (withDevice: boolean) => ({
        width: { ideal: MAX_WIDTH, max: MAX_WIDTH },
        height: { ideal: MAX_HEIGHT, max: MAX_HEIGHT },
        frameRate: { ideal: MAX_FPS, max: MAX_FPS },
        ...(withDevice && cam ? { deviceId: { exact: cam } } : {}),
      });

      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { ...AUDIO_CONSTRAINTS, ...(mic ? { deviceId: { exact: mic } } : {}) },
          video: video ? videoConstraints(true) : false,
        });
      } catch (error) {
        console.error('CALL ERROR:', error);
        // A stale stored deviceId must never block the call — retry with defaults.
        if (!mic && !cam) return null;
        try {
          return await navigator.mediaDevices.getUserMedia({
            audio: AUDIO_CONSTRAINTS,
            video: video ? videoConstraints(false) : false,
          });
        } catch (retryError) {
          console.error('CALL ERROR:', retryError);
          return null;
        }
      }
    },
    [],
  );

  // ---- peer plumbing (perfect negotiation) --------------------------------
  const closePeer = useCallback((id: string) => {
    const peer = peers.current.get(id);
    if (!peer) return;
    if (peer.ping) window.clearInterval(peer.ping);
    try {
      peer.dc?.close();
    } catch {
      /* already closed */
    }
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.ondatachannel = null;
    try {
      peer.pc.close();
    } catch {
      /* already closed */
    }
    peers.current.delete(id);
    setPeerInfo((previous) => {
      if (!(id in previous)) return previous;
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }, []);

  const teardown = useCallback(() => {
    for (const id of [...peers.current.keys()]) closePeer(id);
    if (heartbeat.current) window.clearInterval(heartbeat.current);
    if (sweeper.current) window.clearInterval(sweeper.current);
    if (answerTimer.current) window.clearTimeout(answerTimer.current);
    heartbeat.current = null;
    sweeper.current = null;
    answerTimer.current = null;
    for (const timer of reactionTimers.current) window.clearTimeout(timer);
    reactionTimers.current = [];
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    preview.current?.getTracks().forEach((track) => track.stop());
    preview.current = null;
    shareRef.current?.getTracks().forEach((track) => track.stop());
    shareRef.current = null;
    ownVideoTrack.current = null;
    if (channel.current) void supabase.removeChannel(channel.current);
    channel.current = null;
    channelReleased.current = false;
    promoted.current = false;
    hostRef.current = false;
    pending.current = null;
    room.current = null;
  }, [closePeer]);

  /** Full local reset plus an optional toast key. */
  const finish = useCallback(
    (noticeKey: string | null, nextStatus: CallStatus = 'ended') => {
      teardown();
      setIncoming(null);
      setPeerIds([]);
      setLocalStream(null);
      setAudioOnly(false);
      setMuted(false);
      setCameraOff(false);
      setIsHost(false);
      setRoomCode(null);
      setPeerName(null);
      setPeerInfo({});
      setShareStream(null);
      setSharing(false);
      setHandRaised(false);
      setReactions([]);
      setStage('idle');
      setLobby([]);
      if (noticeKey) setNotice(noticeKey);
      setStatus(nextStatus);
    },
    [teardown],
  );

  // ---- data channel --------------------------------------------------------
  /** Fans a control message out over every open data channel. */
  const sendDataChannel = useCallback((message: Record<string, unknown>) => {
    const payload = JSON.stringify(message);
    for (const peer of peers.current.values()) {
      if (peer.dc?.readyState !== 'open') continue;
      try {
        peer.dc.send(payload);
      } catch {
        /* dropped mid-send */
      }
    }
  }, []);

  /** Sends a control message to exactly one peer (host lowering a hand). */
  const sendDataChannelTo = useCallback((peerId: string, message: Record<string, unknown>) => {
    const peer = peers.current.get(peerId);
    if (peer?.dc?.readyState !== 'open') return;
    try {
      peer.dc.send(JSON.stringify(message));
    } catch {
      /* dropped mid-send */
    }
  }, []);

  /** Floats an emoji over its sender's tile, then retires it. */
  const pushReaction = useCallback(
    (emoji: string, from: string) => {
      const id = `${from}:${Date.now()}:${Math.floor(performance.now())}`;
      setReactions((previous) => [...previous, { id, emoji, from, self: from === me }]);
      const timer = window.setTimeout(() => {
        setReactions((previous) => previous.filter((item) => item.id !== id));
        reactionTimers.current = reactionTimers.current.filter((handle) => handle !== timer);
      }, REACTION_MS);
      reactionTimers.current.push(timer);
    },
    [me],
  );

  /** Announces our mic / cam / hand / sharing state to every peer. */
  const broadcastState = useCallback(() => {
    sendDataChannel({
      t: 'state',
      micOn: !mutedRef.current,
      camOn: !cameraOffRef.current,
      hand: handRef.current,
      sharing: sharingRef.current,
    });
  }, [sendDataChannel]);

  const mergePeerInfo = useCallback((peerId: string, patch: Partial<PeerInfo>) => {
    setPeerInfo((previous) => {
      const current = previous[peerId] ?? {
        name: '',
        micOn: true,
        camOn: true,
        sharing: false,
        hand: false,
        host: false,
        connection: 'new' as PeerConnState,
      };
      return { ...previous, [peerId]: { ...current, ...patch } };
    });
  }, []);

  const attachDataChannel = useCallback((peer: Peer, dc: RTCDataChannel) => {
    peer.dc = dc;

    dc.onopen = () => {
      peer.dcOpen = true;
      peer.lastSeen = Date.now();

      // Introduce ourselves so the remote tile can show a name and current state.
      try {
        dc.send(JSON.stringify({
          t: 'hello',
          name: myName,
          micOn: !mutedRef.current,
          camOn: !cameraOffRef.current,
          hand: handRef.current,
          sharing: sharingRef.current,
          host: hostRef.current,
        }));
      } catch {
        /* closed mid-send */
      }

      // Every peer is on a data channel → the signaling plane has done its job.
      const everyone = peers.current.size > 0
        && [...peers.current.values()].every((item) => item.dcOpen);
      if (everyone && channel.current) {
        const ch = channel.current;
        channel.current = null;
        channelReleased.current = true;
        void supabase.removeChannel(ch);
      }

      if (peer.ping === null) {
        peer.ping = window.setInterval(() => {
          if (dc.readyState !== 'open') return;
          try {
            dc.send(JSON.stringify({ t: 'ping' }));
          } catch {
            /* closed mid-send */
          }
        }, DC_PING_MS);
      }
    };

    dc.onmessage = (event) => {
      peer.lastSeen = Date.now();
      // Control messages ride the data channel because signaling may already be
      // released — without this a settled room could never receive call:ended.
      try {
        const data = JSON.parse(String(event.data)) as {
          t?: string;
          name?: string;
          micOn?: boolean;
          camOn?: boolean;
          hand?: boolean;
          sharing?: boolean;
          host?: boolean;
          emoji?: string;
        };

        if (data?.t === 'ended') {
          finish('room-ended');
          return;
        }
        if (data?.t === 'hello' || data?.t === 'state') {
          mergePeerInfo(peer.id, {
            ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
            micOn: data.micOn !== false,
            camOn: data.camOn !== false,
            hand: data.hand === true,
            sharing: data.sharing === true,
            host: data.host === true,
          });
          return;
        }
        if (data?.t === 'reaction' && typeof data.emoji === 'string') {
          pushReaction(data.emoji, peer.id);
          return;
        }
        if (data?.t === 'lower-hand') {
          handRef.current = false;
          setHandRaised(false);
        }
      } catch {
        /* heartbeat payload or non-JSON frame */
      }
    };

    dc.onclose = () => {
      peer.dcOpen = false;
      if (peer.ping !== null) {
        window.clearInterval(peer.ping);
        peer.ping = null;
      }
      // A dropped data channel means we need signaling again.
      if (channelReleased.current) reattachRef.current();
    };
  }, [finish, myName, mergePeerInfo, pushReaction]);

  const ensurePeer = useCallback(
    (peerId: string): Peer => {
      const existing = peers.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const peer: Peer = {
        id: peerId,
        pc,
        dc: null,
        dcOpen: false,
        ping: null,
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
      mergePeerInfo(peerId, { connection: 'new' });

      for (const track of stream.current?.getTracks() ?? []) {
        pc.addTrack(track, stream.current as MediaStream);
      }
      void tuneSenders(pc);

      // Exactly one side opens the data channel per pair (the impolite peer),
      // so a pair never ends up with two channels fighting for the heartbeat.
      if (!peer.polite) {
        try {
          attachDataChannel(peer, pc.createDataChannel('care'));
        } catch (error) {
          console.error('CALL ERROR:', error);
        }
      }
      pc.ondatachannel = (event) => attachDataChannel(peer, event.channel);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) send(EV.ice, { to: peerId, candidate: candidate.toJSON(), kind: kindRef.current });
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
          send(EV.offer, { to: peerId, description: pc.localDescription ?? undefined, kind: kindRef.current });
        } catch (error) {
          console.error('CALL ERROR:', error);
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        mergePeerInfo(peerId, { connection: state });
        if (state === 'connected') {
          peer.iceRestarted = false;
          peer.audioRetried = false;
          retryCount.current = 0;
          if (answerTimer.current) window.clearTimeout(answerTimer.current);
          setStatus('active');
          return;
        }

        // Signaling was released once the mesh settled; a peer dropping means
        // we must be reachable again to renegotiate.
        if ((state === 'disconnected' || state === 'failed') && channelReleased.current) {
          reattachRef.current();
        }

        if (state !== 'failed') return;
        console.error('CALL ERROR: connection failed for', peerId);

        // 1) one silent ICE restart
        if (!peer.iceRestarted) {
          peer.iceRestarted = true;
          void (async () => {
            try {
              await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
              send(EV.offer, { to: peerId, description: pc.localDescription ?? undefined, kind: kindRef.current });
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
    [me, send, getMedia, attachDataChannel, mergePeerInfo],
  );

  /** Lazily creates the peer entry for an inbound signal. */
  const peerOf = useCallback(
    (id: string): Peer => ensurePeer(id),
    [ensurePeer],
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
        send(EV.answer, { to: from, description: pc.localDescription ?? undefined, kind: kindRef.current });
      }
    },
    [ensurePeer, send],
  );

  // ---- channel -------------------------------------------------------------
  const attachChannel = useCallback(
    (targetRoom: string) => {
      if (channel.current) return;

      const ch = supabase.channel(`call:${targetRoom}`, {
        config: { broadcast: { self: false } },
      });

      ch.on('broadcast', { event: EV.join }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        if (peers.current.size >= MAX_MESH) return;

        // Only connect when we are actually in session WITH media. Someone in
        // the green room or the waiting room has no tracks yet, so a call:join
        // must not trigger a peer connection for them.
        if (
          room.current === targetRoom &&
          statusRef.current !== 'idle' &&
          stageRef.current === 'idle' &&
          stream.current
        ) {
          // Already in this room — greet the newcomer and open a connection to
          // them (adding tracks triggers the offer).
          send(EV.heartbeat, { to: data.from, kind: kindRef.current });
          peerOf(data.from);
          return;
        }

        kindRef.current = data.kind ?? 'video';
        setKind(data.kind ?? 'video');
        setIncoming({ roomId: targetRoom, from: data.from, kind: data.kind ?? 'video', name: data.name });
        setStatus('incoming');
      });

      ch.on('broadcast', { event: EV.offer }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me || !data.description) return;
        peerOf(data.from).lastSeen = Date.now();
        void applyDescription(data.from, data.description).catch((error) => console.error('CALL ERROR:', error));
      });

      ch.on('broadcast', { event: EV.answer }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me || !data.description) return;
        peerOf(data.from).lastSeen = Date.now();
        void applyDescription(data.from, data.description).catch((error) => console.error('CALL ERROR:', error));
      });

      ch.on('broadcast', { event: EV.ice }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me || !data.candidate) return;
        const peer = peerOf(data.from);
        peer.lastSeen = Date.now();
        void peer.pc.addIceCandidate(data.candidate).catch((error) => {
          if (!peer.ignoreOffer) console.error('CALL ERROR:', error);
        });
      });

      ch.on('broadcast', { event: EV.heartbeat }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        const peer = peers.current.get(data.from);
        if (peer) peer.lastSeen = Date.now();
      });

      ch.on('broadcast', { event: EV.decline }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        finish('declined');
      });

      ch.on('broadcast', { event: EV.leave }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        closePeer(data.from);
        setPeerIds([...peers.current.keys()]);
        // A meeting room stays open after someone leaves; a 1:1 call ends.
        if (peers.current.size === 0 && !hostRef.current && !roomCodeRef.current) {
          finish(null);
        }
      });

      ch.on('broadcast', { event: EV.ended }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        // The host ended the room for everyone.
        finish('room-ended');
      });

      // --- Waiting room ------------------------------------------------------
      ch.on('broadcast', { event: EV.lobby }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.from || data.from === me) return;
        // Only the host keeps a lobby list.
        if (!hostRef.current) return;
        setLobby((previous) =>
          previous.some((guest) => guest.id === data.from)
            ? previous
            : [...previous, { id: data.from, name: data.name || data.from }],
        );
      });

      ch.on('broadcast', { event: EV.admit }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.for || data.for !== me) return;
        // We were waiting; the host let us in. Move to the green room — no media
        // has been acquired up to this point.
        void enterPrejoinRef.current();
      });

      ch.on('broadcast', { event: EV.deny }, ({ payload }) => {
        const data = payload as SignalPayload;
        if (!data?.for || data.for !== me) return;
        // Denied — leave quietly; /call/{code} returns us home on 'ended'.
        finish(null, 'ended');
      });

      // Publish the channel before subscribing so the SUBSCRIBED callback can
      // broadcast over it.
      channel.current = ch;
      ch.subscribe((subscribeStatus) => {
        if (subscribeStatus !== 'SUBSCRIBED') return;

        // Waiting room: announce ourselves but do NOT join the media session.
        if (stageRef.current === 'lobby') {
          send(EV.lobby, { name: myName });
          return;
        }

        // Green room: never announce a join before "Join now" (commitJoin flips
        // the stage back to 'idle').
        if (stageRef.current === 'prejoin') return;

        send(EV.join, { name: myName, kind: kindRef.current });

        // Host promotes the room out of 'waiting' once signaling is live.
        if (hostRef.current && !promoted.current && room.current) {
          promoted.current = true;
          void setRoomStatus(room.current, 'active').catch((error) => console.error('CALL ERROR:', error));
        }
      });
    },
    [me, myName, send, applyDescription, closePeer, finish, peerOf],
  );

  // Re-subscribe after a dropped peer connection released the signaling plane.
  useEffect(() => {
    reattachRef.current = () => {
      if (!channelReleased.current || channel.current) return;
      const target = room.current;
      if (!target) return;
      channelReleased.current = false;
      attachChannel(target);
    };
  }, [attachChannel]);

  const startTimers = useCallback(() => {
    if (sweeper.current === null) {
      sweeper.current = window.setInterval(() => {
        const now = Date.now();
        for (const [id, peer] of peers.current) {
          if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
            console.error('CALL ERROR: peer timed out', id);
            send(EV.leave, { to: id, kind: kindRef.current });
            closePeer(id);
          }
        }
        setPeerIds([...peers.current.keys()]);
      }, HEARTBEAT_MS);
    }

    if (heartbeat.current === null) {
      heartbeat.current = window.setInterval(() => {
        send(EV.heartbeat, { kind: kindRef.current });
        let pending = 0;
        for (const peer of peers.current.values()) {
          pending += Number(peer.pc.connectionState !== 'connected');
        }
        setQuality(pending === 0 ? 'good' : pending === 1 ? 'fair' : 'poor');
      }, HEARTBEAT_MS);
    }
  }, [send, closePeer]);

  // ---- devices -------------------------------------------------------------
  /** Re-enumerates devices. Labels only populate after media permission. */
  const refreshDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setMics(
        all
          .filter((device) => device.kind === 'audioinput')
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${index + 1}`,
          })),
      );
      setCams(
        all
          .filter((device) => device.kind === 'videoinput')
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Camera ${index + 1}`,
          })),
      );
    } catch (error) {
      console.error('CALL ERROR:', error);
    }
  }, []);

  /** Applies a mic/camera change in whichever phase we are in. */
  const applyDeviceChange = useCallback(async () => {
    // Green room: refresh the local preview only.
    if (stageRef.current === 'prejoin') {
      preview.current?.getTracks().forEach((track) => track.stop());
      const media = await getMedia(true);
      if (!alive.current) return;
      preview.current = media;
      setLocalStream(media);
      return;
    }

    // In a call: swap tracks on every sender. While sharing, the video sender
    // carries the display track, so only audio is swapped.
    if (!stream.current) return;
    const media = await getMedia(true, { micId: micIdRef.current, camId: camIdRef.current });
    if (!media || !alive.current) return;

    const sharingNow = sharingRef.current;
    const audio = media.getAudioTracks()[0] ?? null;
    const video = media.getVideoTracks()[0] ?? null;

    if (!sharingNow) stream.current.getVideoTracks().forEach((track) => track.stop());
    stream.current.getAudioTracks().forEach((track) => track.stop());

    const rebuilt = new MediaStream();
    if (audio) rebuilt.addTrack(audio);
    const keepVideo = sharingNow ? shareRef.current?.getVideoTracks()[0] ?? null : video;
    if (keepVideo) rebuilt.addTrack(keepVideo);
    stream.current = rebuilt;
    if (!sharingNow && video) ownVideoTrack.current = video;
    setLocalStream(rebuilt);

    for (const peer of peers.current.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track?.kind === 'audio' && audio) await sender.replaceTrack(audio);
        if (sender.track?.kind === 'video' && video && !sharingNow) await sender.replaceTrack(video);
      }
    }
  }, [getMedia]);

  const selectMic = useCallback(
    async (deviceId: string) => {
      micIdRef.current = deviceId;
      setMicId(deviceId);
      storeDevice('mic', deviceId);
      await applyDeviceChange();
    },
    [applyDeviceChange],
  );

  const selectCamera = useCallback(
    async (deviceId: string) => {
      camIdRef.current = deviceId;
      setCamId(deviceId);
      storeDevice('cam', deviceId);
      await applyDeviceChange();
    },
    [applyDeviceChange],
  );

  // ---- green room / waiting room -------------------------------------------
  /** Green room: acquire a local preview. No peer connection, no signaling. */
  const enterPrejoin = useCallback(async () => {
    // A guest admitted from the waiting room: drop the lobby channel so the
    // green-room join re-subscribes and can announce call:join.
    if (channel.current) {
      void supabase.removeChannel(channel.current);
      channel.current = null;
    }
    channelReleased.current = false;

    setStage('prejoin');
    stageRef.current = 'prejoin';

    preview.current?.getTracks().forEach((track) => track.stop());
    const media = await getMedia(true);
    if (!alive.current) return;
    preview.current = media;
    // The preview doubles as the local stream so the mirrored self-view renders.
    setLocalStream(media);
    // Labels are only available once permission has been granted.
    await refreshDevices();
  }, [getMedia, refreshDevices]);

  useEffect(() => {
    enterPrejoinRef.current = enterPrejoin;
  }, [enterPrejoin]);

  /**
   * Opens a room WITHOUT touching media: either the green room, or — when the
   * waiting room applies to a guest — a media-less lobby subscription.
   */
  const openRoom = useCallback(
    async (targetRoom: string, options?: OpenRoomOptions) => {
      if (!me) return;
      const key = normalizeCode(targetRoom);
      if (!key) return;
      if (room.current === key) return;

      pending.current = { key, options: options ?? {} };
      room.current = key;
      roomCodeRef.current = options?.code ? key : null;
      hostRef.current = Boolean(options?.isHost);
      promoted.current = false;
      channelReleased.current = false;
      kindRef.current = 'video';

      setRoomId(key);
      setRoomCode(options?.code ? key : null);
      setIsHost(Boolean(options?.isHost));
      setKind('video');
      setNotice(null);
      setIncoming(null);
      setPeerName(null);
      setLobbyEnabled(Boolean(options?.lobby));
      setLobby([]);
      void refreshDevices();

      // Guests wait in the lobby; the host bypasses it entirely.
      if (options?.lobby && !options?.isHost) {
        setStage('lobby');
        stageRef.current = 'lobby';
        setStatus('idle');
        // Subscribed but media-less: SUBSCRIBED broadcasts call:lobby only.
        attachChannel(key);
        return;
      }

      await enterPrejoin();
    },
    [me, attachChannel, enterPrejoin, refreshDevices],
  );

  /** "Join now" — promote the preview to the live call and connect. */
  const commitJoin = useCallback(async () => {
    const todo = pending.current;
    if (!todo) return;

    retryCount.current = 0;
    kindRef.current = 'video';
    audioOnlyRef.current = false;
    hostRef.current = Boolean(todo.options.isHost);
    promoted.current = false;
    channelReleased.current = false;
    roomCodeRef.current = todo.options.code ? todo.key : null;
    room.current = todo.key;

    setRoomId(todo.key);
    setRoomCode(todo.options.code ? todo.key : null);
    setKind('video');
    setAudioOnly(false);
    setIsHost(Boolean(todo.options.isHost));
    setNotice(null);
    setIncoming(null);
    setStatus('connecting');

    const media = preview.current;
    stream.current = media;
    setLocalStream(media);
    ownVideoTrack.current = media?.getVideoTracks()[0] ?? null;
    preview.current = null;

    // Carry the green-room mic/camera choices into the call state.
    const micMuted = media?.getAudioTracks()[0]?.enabled === false;
    const camOff = media?.getVideoTracks()[0]?.enabled === false;
    mutedRef.current = micMuted;
    cameraOffRef.current = camOff;
    setMuted(micMuted);
    setCameraOff(camOff);

    // Flip the stage BEFORE subscribing so SUBSCRIBED announces call:join.
    stageRef.current = 'idle';
    setStage('idle');

    // Consume the pending room so a second "Join now" cannot re-join.
    pending.current = null;

    startTimers();
    attachChannel(todo.key);
  }, [attachChannel, startTimers]);

  /** Backs out of the green room / lobby without ever connecting. */
  const cancelPrejoin = useCallback(() => {
    finish(null, 'idle');
  }, [finish]);

  // ---- screen share --------------------------------------------------------
  const stopShare = useCallback(async () => {
    const cameraTrack = ownVideoTrack.current;
    for (const peer of peers.current.values()) {
      const sender = peer.pc.getSenders().find((item) => item.track?.kind === 'video');
      if (sender && cameraTrack) await sender.replaceTrack(cameraTrack);
    }
    shareRef.current?.getTracks().forEach((track) => track.stop());
    shareRef.current = null;
    setShareStream(null);
    sharingRef.current = false;
    setSharing(false);
    broadcastState();
  }, [broadcastState]);

  useEffect(() => {
    stopShareRef.current = stopShare;
  }, [stopShare]);

  const startShare = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) return;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      if (!track) return;

      shareRef.current = display;
      ownVideoTrack.current = stream.current?.getVideoTracks()[0] ?? ownVideoTrack.current;

      // One replaceTrack per peer: the grid then shows the share as this tile.
      for (const peer of peers.current.values()) {
        const sender = peer.pc.getSenders().find((item) => item.track?.kind === 'video');
        if (sender) await sender.replaceTrack(track);
      }

      setShareStream(display);
      sharingRef.current = true;
      setSharing(true);
      broadcastState();

      // The browser's own "Stop sharing" control ends the track — mirror it.
      track.onended = () => {
        void stopShareRef.current();
      };
    } catch (error) {
      console.error('CALL ERROR:', error);
    }
  }, [broadcastState]);

  // ---- reactions / hands ---------------------------------------------------
  const sendReaction = useCallback(
    (emoji: string) => {
      sendDataChannel({ t: 'reaction', emoji });
      pushReaction(emoji, me);
    },
    [sendDataChannel, pushReaction, me],
  );

  const toggleHand = useCallback(() => {
    const next = !handRef.current;
    handRef.current = next;
    setHandRaised(next);
    broadcastState();
  }, [broadcastState]);

  const lowerPeerHand = useCallback(
    (peerId: string) => {
      sendDataChannelTo(peerId, { t: 'lower-hand' });
      mergePeerInfo(peerId, { hand: false });
    },
    [sendDataChannelTo, mergePeerInfo],
  );

  // ---- waiting room (host) -------------------------------------------------
  const admitGuest = useCallback(
    (id: string) => {
      send(EV.admit, { for: id });
      setLobby((previous) => previous.filter((guest) => guest.id !== id));
    },
    [send],
  );

  const denyGuest = useCallback(
    (id: string) => {
      send(EV.deny, { for: id });
      setLobby((previous) => previous.filter((guest) => guest.id !== id));
    },
    [send],
  );

  // Keep the device list current when hardware is plugged or unplugged.
  useEffect(() => {
    void refreshDevices();
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return;
    const onChange = () => void refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  // ---- actions -------------------------------------------------------------
  const joinCall = useCallback(
    async (
      targetRoom: string,
      nextKind: CallKind = 'video',
      options?: JoinOptions,
    ) => {
      if (!me) return;
      const key = normalizeCode(targetRoom);
      if (!key) return;
      if (room.current === key) return;

      retryCount.current = 0;
      kindRef.current = nextKind;
      audioOnlyRef.current = false;
      hostRef.current = Boolean(options?.isHost);
      promoted.current = false;
      channelReleased.current = false;
      roomCodeRef.current = options?.code ? key : null;
      setKind(nextKind);
      setAudioOnly(false);
      setIsHost(Boolean(options?.isHost));
      setRoomCode(options?.code ? key : null);
      setNotice(null);
      setIncoming(null);
      setStatus('connecting');
      room.current = key;
      setRoomId(key);

      const media = await getMedia(nextKind === 'video');
      if (!alive.current) return;

      stream.current = media;
      setLocalStream(media);

      startTimers();
      attachChannel(key);
    },
    [me, getMedia, attachChannel, startTimers],
  );

  const startCall = useCallback(
    async (target: string, nextKind: CallKind = 'video', name?: string) => {
      if (!me || !target) return;
      setPeerName(name ?? null);
      const targetRoom = nextKind === 'emergency' ? target : peerRoom(me, target);
      await joinCall(targetRoom, nextKind);

      if (nextKind !== 'emergency') return;

      // Emergency: re-invite with backoff, then fall back to a persistent alert.
      const attempt = (n: number) => {
        if (!alive.current || room.current !== normalizeCode(targetRoom)) return;
        if (peers.current.size > 0) return;

        send(EV.join, { kind: 'emergency' });
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
    const callerName = incoming.name ?? null;
    await joinCall(incoming.roomId, incoming.kind);
    if (callerName) setPeerName(callerName);
  }, [incoming, joinCall]);

  const declineCall = useCallback(() => {
    if (incoming) send(EV.decline, { to: incoming.from, kind: incoming.kind });
    // Declining is silent for the decliner; the caller sees the notice.
    finish(null, 'idle');
  }, [incoming, send, finish]);

  const endCall = useCallback(() => {
    send(EV.leave, { kind: kindRef.current });
    finish(null, 'idle');
  }, [send, finish]);

  const endForAll = useCallback(() => {
    const code = room.current;
    if (!code) return;

    // Belt and braces: the broadcast reaches peers that still hold signaling,
    // the data channel reaches peers that already released it.
    sendDataChannel({ t: 'ended' });

    if (channel.current) {
      send(EV.ended, { kind: kindRef.current });
    } else {
      // Signaling was released once the data channels opened — re-attach just
      // long enough to deliver the final broadcast, then drop it again.
      const ch = supabase.channel(`call:${code}`, { config: { broadcast: { self: false } } });
      ch.subscribe((subscribeStatus) => {
        if (subscribeStatus !== 'SUBSCRIBED') return;
        void ch
          .send({ type: 'broadcast', event: EV.ended, payload: { from: me } })
          .then(() => window.setTimeout(() => void supabase.removeChannel(ch), 800));
      });
    }

    void setRoomStatus(code, 'ended').catch((error) => console.error('CALL ERROR:', error));
    window.setTimeout(() => finish('room-ended'), 400);
  }, [me, send, finish, sendDataChannel]);

  const toggleMic = useCallback(() => {
    const track = stream.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
    mutedRef.current = !track.enabled;
    broadcastState();
  }, [broadcastState]);

  const toggleCamera = useCallback(() => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOff(!track.enabled);
    cameraOffRef.current = !track.enabled;
    broadcastState();
  }, [broadcastState]);

  // Stable identities: CallPage registers notify as an effect dependency, and
  // CallLayer's auto-dismiss timer resets whenever clearNotice changes.
  const notify = useCallback((messageKey: string) => setNotice(messageKey), []);
  const clearNotice = useCallback(() => setNotice(null), []);

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

  // Self first, then remotes — the participants panel reads this directly.
  const participants = useMemo<Participant[]>(() => {
    const self: Participant = {
      id: me,
      name: myName || me,
      self: true,
      host: isHost,
      micOn: !muted,
      camOn: !cameraOff,
      sharing,
      hand: handRaised,
      connection: 'connected',
    };

    const remotes = peerIds.map((id) => {
      const info = peerInfo[id];
      return {
        id,
        name: info?.name || id,
        self: false,
        host: info?.host ?? false,
        micOn: info?.micOn ?? true,
        camOn: info?.camOn ?? true,
        sharing: info?.sharing ?? false,
        hand: info?.hand ?? false,
        connection: info?.connection ?? ('new' as PeerConnState),
      };
    });

    return [self, ...remotes];
  }, [me, myName, isHost, muted, cameraOff, sharing, handRaised, peerIds, peerInfo]);

  return {
    status,
    kind,
    roomId,
    roomCode,
    isHost,
    peerName,
    connectedAt,
    incoming,
    peers: list,
    peerInfo,
    localStream,
    shareStream,
    audioOnly,
    muted,
    cameraOff,
    sharing,
    handRaised,
    reactions,
    quality,
    notice,
    stats,
    showStats,
    toggleStats: () => setShowStats((previous) => !previous),
    stage,
    lobby,
    lobbyEnabled,
    devices: { mics, cams },
    micId,
    camId,
    participants,
    startCall,
    joinCall,
    openRoom,
    commitJoin,
    cancelPrejoin,
    acceptCall,
    declineCall,
    endCall,
    endForAll,
    toggleMic,
    toggleCamera,
    toggleHand,
    lowerPeerHand,
    startShare,
    stopShare,
    sendReaction,
    refreshDevices,
    selectMic,
    selectCamera,
    admitGuest,
    denyGuest,
    notify,
    clearNotice,
  };
}
