// Scrolling back through rows much taller than the average (pasted
// documents: one PRIVMSG per line, shown as one block) never has the list
// write scrollTop under the user's scroll: rows above are measured ahead
// while the list is still, and what's left is made up out of sight. A
// write mid-scroll cancels a smooth scroll in WebKit (Safari, the iOS app)
// and stalls a frame elsewhere: the skip.
//
// ?tall=N: N pasted multi-line blocks in #dev (shots.tsx).
import { expect, test, type Page } from '@playwright/test';

const list = (page: Page) => page.locator('main .chat-messages');

// Every scrollTop write on the list and every wheel event, timed.
async function trace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: Array<{ t: number; set?: number; was?: number; wheel?: true }> = [];
    (globalThis as { __scrollTrace?: unknown }).__scrollTrace = log;
    const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get() { return d.get!.call(this); },
      set(v: number) {
        if ((this as Element).classList?.contains('chat-messages')) log.push({ t: performance.now(), set: v, was: d.get!.call(this) as number });
        d.set!.call(this, v);
      },
    });
    addEventListener('wheel', () => log.push({ t: performance.now(), wheel: true }), { capture: true, passive: true });
  });
}

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 760 }]) {
  test(`${vp.name}: flicking up through tall pasted blocks, nothing writes scrollTop mid-scroll`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await trace(page);
    await page.goto('/shots.html?view=chat&frame=1&tall=40', { waitUntil: 'domcontentloaded' });
    await expect(list(page).locator('.vrow').first()).toBeVisible();
    await page.waitForTimeout(2500); // the harness has pinned it to the bottom
    // Where every row on screen is, every frame (for jumps backwards).
    await page.evaluate(() => {
      const g = globalThis as { __scrollTrace?: unknown[]; __frames?: Array<Record<string, number>> };
      (g.__scrollTrace as unknown[]).length = 0;
      const frames: Array<Record<string, number>> = [];
      g.__frames = frames;
      const el = document.querySelector<HTMLElement>('main .chat-messages')!;
      const tick = (): void => {
        const box = el.getBoundingClientRect();
        const rows: Record<string, number> = {};
        for (const r of Array.from(el.querySelectorAll<HTMLElement>('.vrow'))) {
          const b = r.getBoundingClientRect();
          if (b.bottom > box.top && b.top < box.bottom) rows[r.dataset['vkey']!] = b.top;
        }
        frames.push(rows);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const box = (await list(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Flicks: a burst of wheel steps, a pause (as a hand does).
    for (let i = 0; i < 260 && (await list(page).evaluate((el) => el.scrollTop)) > 0; i++) {
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(i % 10 === 9 ? 450 : 40);
    }
    await page.waitForTimeout(600);
    expect(await list(page).evaluate((el) => el.scrollTop)).toBe(0);
    await expect(list(page).getByText('## Notes 0').or(list(page).getByText('Notes 0')).first()).toBeVisible();

    const log = await page.evaluate(() => (globalThis as { __scrollTrace?: Array<{ t: number; set?: number; was?: number; wheel?: true }> }).__scrollTrace!);
    const wheels = log.filter((e) => e.wheel).map((e) => e.t);
    const midScroll = log.filter((e) => e.set !== undefined && Math.abs(e.set - e.was!) > 1 && wheels.some((w) => e.t >= w && e.t - w < 150));
    expect(midScroll, 'scrollTop written mid-scroll').toEqual([]);

    const frames = await page.evaluate(() => (globalThis as { __frames?: Array<Record<string, number>> }).__frames!);
    const back: number[] = [];
    for (let i = 1; i < frames.length; i++) {
      const shifts = Object.keys(frames[i]!).filter((k) => k in frames[i - 1]!).map((k) => frames[i]![k]! - frames[i - 1]![k]!);
      if (!shifts.length) continue;
      const s = shifts.sort((a, b) => a - b)[Math.floor(shifts.length / 2)]!;
      if (s < -2) back.push(s);
    }
    expect(back, 'rows jumped back down while scrolling up').toEqual([]);
  });
}
