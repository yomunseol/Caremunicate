import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Call recording.
//
// MediaRecorder over a stream we build ourselves: the local + every remote
// audio track mixed through one MediaStreamDestination, plus the local camera
// track for picture. We borrow tracks (never stop them) and tear the mix graph
// down on stop/unmount, so recording never disturbs the live call.
// ---------------------------------------------------------------------------

export type RecordingPeer = { id: string; stream: MediaStream | null };

const pickMime = (): string => {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'audio/webm',
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* ignore */
    }
  }
  return '';
};

export function useCallRecording(localStream: MediaStream | null, peers: RecordingPeer[]) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const context = useRef<AudioContext | null>(null);
  const sources = useRef<MediaStreamAudioSourceNode[]>([]);
  const mixedAudio = useRef<MediaStreamTrack | null>(null);

  /** Release the mix graph. Never stops the borrowed camera/remote tracks. */
  const cleanup = useCallback(() => {
    for (const node of sources.current) {
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
    }
    sources.current = [];
    mixedAudio.current?.stop();
    mixedAudio.current = null;
    void context.current?.close().catch(() => {});
    context.current = null;
    recorder.current = null;
    chunks.current = [];
  }, []);

  const start = useCallback(() => {
    if (recorder.current) return;
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
      setError('unsupported');
      return;
    }
    setError('');

    const mix = new MediaStream();
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (Ctor) {
      const ctx = new Ctor();
      context.current = ctx;
      const destination = ctx.createMediaStreamDestination();
      const add = (stream: MediaStream | null) => {
        if (!stream || stream.getAudioTracks().length === 0) return;
        try {
          const source = ctx.createMediaStreamSource(stream);
          source.connect(destination);
          sources.current.push(source);
        } catch {
          /* stream not ready — skip it */
        }
      };
      add(localStream);
      for (const peer of peers) add(peer.stream);

      const audio = destination.stream.getAudioTracks()[0];
      if (audio) {
        mix.addTrack(audio);
        mixedAudio.current = audio;
      }
    }

    // Picture: borrow the local camera track (stopped only by the call itself).
    const video = localStream?.getVideoTracks()[0];
    if (video) mix.addTrack(video);

    if (mix.getTracks().length === 0) {
      setError('nosources');
      cleanup();
      return;
    }

    const mimeType = pickMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(mix, mimeType ? { mimeType } : undefined);
    } catch {
      setError('unsupported');
      cleanup();
      return;
    }

    chunks.current = [];
    rec.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.current.push(event.data);
    };
    rec.start(1000);
    recorder.current = rec;
    setRecording(true);
  }, [localStream, peers, cleanup]);

  /** Stop and hand back the finished blob (null when nothing was recording). */
  const stop = useCallback(async (): Promise<Blob | null> => {
    const rec = recorder.current;
    if (!rec) return null;

    const blob = await new Promise<Blob | null>((resolve) => {
      rec.onstop = () =>
        resolve(new Blob(chunks.current, { type: chunks.current[0]?.type || 'video/webm' }));
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });

    setRecording(false);
    cleanup();
    return blob;
  }, [cleanup]);

  useEffect(
    () => () => {
      try {
        recorder.current?.stop();
      } catch {
        /* already stopped */
      }
      cleanup();
    },
    [cleanup],
  );

  return { recording, error, start, stop };
}
