let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

/**
 * Short two-tone "ping". Synthesized via Web Audio so there's no asset to
 * ship and it works offline. No-op if the browser has no audio context or
 * the autoplay policy keeps it suspended (no user gesture yet this session).
 */
export function playPing(): void {
  const ac = audioContext();
  if (!ac) return;
  if (ac.state === "suspended") void ac.resume();
  const now = ac.currentTime;
  const tones = [
    { freq: 880, at: 0, dur: 0.12 },
    { freq: 1320, at: 0.1, dur: 0.18 },
  ];
  for (const t of tones) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = t.freq;
    const start = now + t.at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + t.dur);
  }
}
