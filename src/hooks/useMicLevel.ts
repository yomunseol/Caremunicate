import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Green-room mic meter.
//
// One AnalyserNode on the preview stream, polled for RMS — the same maths as
// useActiveSpeaker, scaled to 0..1 for a level bar. Kept cheap: it only runs
// while the green room is open.
// ---------------------------------------------------------------------------

const POLL_MS = 80;

export function useMicLevel(stream: MediaStream | null, enabled = true): number {
  const [level, setLevel] = useState(0);
  const contextRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<{
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    data: Uint8Array<ArrayBuffer>;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !stream || typeof window === 'undefined') {
      setLevel(0);
      return;
    }

    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    if (!contextRef.current) contextRef.current = new Ctor();
    const context = contextRef.current;
    if (context.state === 'suspended') void context.resume();

    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      nodeRef.current = {
        source,
        analyser,
        data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      };
    } catch {
      return;
    }

    const timer = window.setInterval(() => {
      const node = nodeRef.current;
      if (!node) return;

      node.analyser.getByteTimeDomainData(node.data);
      let sum = 0;
      for (let i = 0; i < node.data.length; i += 1) {
        const value = (node.data[i] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / node.data.length);
      const next = Math.min(1, rms * 4);
      setLevel((previous) => (Math.abs(next - previous) < 0.02 ? previous : next));
    }, POLL_MS);

    return () => {
      window.clearInterval(timer);
      const node = nodeRef.current;
      if (node) {
        try {
          node.source.disconnect();
        } catch {
          /* already gone */
        }
        nodeRef.current = null;
      }
      setLevel(0);
    };
  }, [stream, enabled]);

  useEffect(
    () => () => {
      const node = nodeRef.current;
      if (node) {
        try {
          node.source.disconnect();
        } catch {
          /* already gone */
        }
        nodeRef.current = null;
      }
      void contextRef.current?.close().catch(() => {});
      contextRef.current = null;
    },
    [],
  );

  return level;
}
