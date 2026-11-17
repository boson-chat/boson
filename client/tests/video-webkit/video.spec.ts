import { expect, test } from '@playwright/test';

// The self-view, a remote camera and a remote screen share all draw real
// pictures, decoded by the browser's own WebCodecs from the app's frame
// socket (FRAME_URL: a real frame hub fed by desktop/video_webkit_test.go).
const FRAME_URL = process.env.FRAME_URL ?? '';

for (const pacing of [false, true]) test(`the self-view, a camera and a screen share all draw${pacing ? ' (smoother screen shares on)' : ''}`, async ({ page }) => {
  test.skip(!FRAME_URL, 'run by desktop/video_webkit_test.go');
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/shots.html?view=chat&voice=connected&video=live&people=2&ws=${encodeURIComponent(FRAME_URL)}${pacing ? '&pacing=1' : ''}`);
  await page.waitForSelector('.stage-tile canvas, .mcall-t canvas, .mcall-pip canvas', { timeout: 15_000 });
  // Each tile's canvas: drawn (sized by a frame) and not blank.
  const painted = async () => page.evaluate(() => {
    const out: Record<string, { w: number; h: number; lit: number }> = {};
    for (const t of document.querySelectorAll('.stage-tile, .mcall-t, .mcall-pip')) {
      const c = t.querySelector('canvas') as HTMLCanvasElement | null;
      if (!c || c.width < 2) continue;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
      // A tile's name: "Focus nova" / "Enlarge nova’s screen" are buttons for them.
      out[(t.getAttribute('aria-label') ?? '?').replace(/^(Focus|Enlarge) /, '')] = { w: c.width, h: c.height, lit };
    }
    return out;
  });
  await expect.poll(async () => {
    const p = await painted();
    // Our own: "you" on the desktop stage, "Your video" (the corner picture) on a phone.
    const self = (p['you']?.lit ?? 0) > 10 || (p['Your video']?.lit ?? 0) > 10;
    return [self ? 'self' : '', ...['nova', 'nova’s screen'].filter((k) => (p[k]?.lit ?? 0) > 10)].filter(Boolean);
  }, { timeout: 20_000, message: 'tiles with a picture' }).toEqual(['self', 'nova', 'nova’s screen']);
  // Still moving a second later (the render loop runs).
  const shown = async () => page.evaluate(() => {
    const c = (globalThis as unknown as { __video?: { stats(): Record<number, { shown: number }> } }).__video;
    return c ? Object.fromEntries(Object.entries(c.stats()).map(([k, v]) => [k, v.shown])) : null;
  });
  const a = await shown();
  await page.waitForTimeout(1500);
  const b = await shown();
  const moving = process.env.REAL_SCREEN ? ['10'] : ['10', '11'];
  if (a && b) for (const id of moving) expect(b[id] ?? 0).toBeGreaterThan((a[id] ?? 0) + 10);
  if (pacing) {
    // The screen is paced by its own buffer, not held for the audio.
    const synced = await page.evaluate(() => (globalThis as unknown as { __video?: { stats(): Record<number, { synced: boolean }> } }).__video?.stats()[11]?.synced);
    expect(synced).toBe(false);
  }
  await page.screenshot({ path: test.info().outputPath('call.png') });
  expect(errors.filter((e) => !/secure-storage/.test(e))).toEqual([]);
});
