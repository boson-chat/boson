// A soft two-tone ring while a call rings for you (Web Audio, no files).
// Best effort: silent where the webview won't start audio.

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function burst(ac: AudioContext): void {
  const now = ac.currentTime;
  for (const [i, f] of [[0, 660], [1, 880]] as const) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = now + i * 0.22;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.02);
    g.gain.linearRampToValueAtTime(0, t + 0.2);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + 0.22);
  }
}

export function startRing(): void {
  if (timer) return;
  try {
    const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AC) return;
    ctx ??= new AC();
    void ctx.resume().catch(() => {});
    burst(ctx);
    timer = setInterval(() => { if (ctx) burst(ctx); }, 2_000);
  } catch { /* no audio */ }
}

export function stopRing(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
