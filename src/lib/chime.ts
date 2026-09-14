// ---------------------------------------------------------------------------
// Event chimes — WebAudio only.
//
// There are NO asset files here: every cue is a couple of sine oscillators
// ramped through a single gain envelope. The AudioContext is created lazily on
// first use (browsers require a user gesture before audio can start) and reused
// for the life of the page.
// ---------------------------------------------------------------------------

let context: AudioContext | null = null;

const audioContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;

  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  if (!context) context = new Ctor();
  if (context.state === 'suspended') void context.resume();
  return context;
};

type Note = { frequency: number; at: number; duration: number };

const play = (notes: Note[], peak = 0.05): void => {
  if (notes.length === 0) return;
  const ctx = audioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const total = Math.max(...notes.map((note) => note.at + note.duration));

  const gain = ctx.createGain();
  // One envelope for the whole cue, so overlapping notes never clip.
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + total + 0.05);
  gain.connect(ctx.destination);

  for (const note of notes) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(note.frequency, now + note.at);
    osc.connect(gain);
    osc.start(now + note.at);
    osc.stop(now + note.at + note.duration);
  }
};

/** Rising two-note blip — someone joined. */
export const playJoinChime = (): void => {
  play([
    { frequency: 660, at: 0, duration: 0.12 },
    { frequency: 990, at: 0.1, duration: 0.16 },
  ]);
};

/** Falling two-note blip — someone left. */
export const playLeaveChime = (): void => {
  play([
    { frequency: 660, at: 0, duration: 0.12 },
    { frequency: 440, at: 0.1, duration: 0.18 },
  ]);
};

/** Single soft note — a hand went up. */
export const playHandChime = (): void => {
  play([{ frequency: 880, at: 0, duration: 0.14 }]);
};
