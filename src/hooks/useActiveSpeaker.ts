import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Voice-activity detection for the speaker view.
//
// One AnalyserNode per stream (local + every remote), polled for RMS. The
// loudest stream above the threshold wins; nobody above it means nobody is
// speaking. Kept deliberately cheap — this runs for the whole call.
// ---------------------------------------------------------------------------

/** RMS above which a stream counts as speaking. */
const SPEAK_THRESHOLD = 0.06;
const POLL_MS = 400;

export type SpeakingStream = { id: string; stream: MediaStream | null };

export function useActiveSpeaker(
  localStream: MediaStream | null,
  peers: SpeakingStream[],
  enabled: boolean,
): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const nodes = useRef(
    new Map<
      string,
      { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }
    >(),
  );

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      setActiveId(null);
      return;
    }

    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    if (!contextRef.current) contextRef.current = new Ctor();
    const context = contextRef.current;
    if (context.state === 'suspended') void context.resume();

    const desired = new Map<string, MediaStream>();
    if (localStream) desired.set('me', localStream);
    for (const peer of peers) {
      if (peer.stream) desired.set(peer.id, peer.stream);
    }

    // Drop analysers for streams that went away.
    for (const [id, node] of nodes.current) {
      if (desired.has(id)) continue;
      try {
        node.source.disconnect();
      } catch {
        /* already gone */
      }
      nodes.current.delete(id);
    }

    // Add analysers for streams we have not seen yet.
    for (const [id, stream] of desired) {
      if (nodes.current.has(id)) continue;
      try {
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        nodes.current.set(id, {
          source,
          analyser,
          data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
        });
      } catch {
        /* stream not ready yet — picked up on the next pass */
      }
    }

    const tick = () => {
      let loudest: string | null = null;
      let peak = SPEAK_THRESHOLD;

      for (const [id, node] of nodes.current) {
        node.analyser.getByteTimeDomainData(node.data);
        let sum = 0;
        for (let i = 0; i < node.data.length; i += 1) {
          const value = (node.data[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / node.data.length);
        if (rms > peak) {
          peak = rms;
          loudest = id;
        }
      }

      setActiveId((previous) => (previous === loudest ? previous : loudest));
    };

    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, localStream, peers]);

  // Release the audio graph when the layer goes away for good.
  useEffect(
    () => () => {
      for (const [, node] of nodes.current) {
        try {
          node.source.disconnect();
        } catch {
          /* already gone */
        }
      }
      nodes.current.clear();
      void contextRef.current?.close().catch(() => {});
      contextRef.current = null;
    },
    [],
  );

  return activeId;
}
