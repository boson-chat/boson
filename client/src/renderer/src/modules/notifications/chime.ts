// A short, soft two-note chime with an in-app notification (Web Audio, no
// files). Best effort: silent where the webview won't start audio.
let ctx: AudioContext | null = null;
let last = 0;

export function chime(): void {
  const now = Date.now();
  if (now - last < 800) return; // a burst of toasts: one chime
  last = now;
  try {
    const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AC) return;
    ctx ??= new AC();
    const ac = ctx;
    void ac.resume().catch(() => {});
    const t0 = ac.currentTime;
    for (const [i, f] of [[0, 880], [1, 1320]] as const) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.045, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.26);
    }
  } catch { /* no audio */ }
}
