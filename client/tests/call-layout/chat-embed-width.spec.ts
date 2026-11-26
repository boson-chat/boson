// Image previews stay inside the message column, and the message list never
// scrolls sideways: a very wide screenshot (3000×800) once rendered at its
// 420px frame on a phone, wider than the column, and the whole list panned
// left and right. Also a very tall image and a long unbroken URL.
import { expect, test, type Page } from '@playwright/test';

const SHAPES: Record<string, { w: number; h: number }> = {
  wide: { w: 3000, h: 800 },
  tall: { w: 800, h: 3000 },
};
function svg(name: string): string {
  const { w, h } = SHAPES[name]!;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<rect width="${w}" height="${h}" fill="${name === 'wide' ? '#3a6ea5' : '#a5563a'}"/>`
    + `<text x="50%" y="50%" font-size="${Math.round(Math.min(w, h) / 4)}" text-anchor="middle" dominant-baseline="middle" fill="#fff">${name}</text></svg>`;
}

const list = (page: Page) => page.locator('main .chat-messages');
const rowWith = (page: Page, text: string) =>
  list(page).locator('.vrow').filter({ has: page.locator('.message-row-text-body', { hasText: text }) });

async function open(page: Page, width: number, height: number): Promise<void> {
  await page.route('https://img.test/**', (route) => {
    const name = /\/(wide|tall)\.png/.exec(route.request().url())?.[1] ?? 'wide';
    void route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(name) });
  });
  await page.setViewportSize({ width, height });
  await page.goto('/shots.html?view=chat&frame=1', { waitUntil: 'domcontentloaded' });
  await expect(list(page)).toBeVisible();
  await page.waitForTimeout(500);
  const emit = (msgid: string, from: string, text: string) => page.evaluate(([id, f, t]) => {
    (window as unknown as { __emit: (e: unknown) => void }).__emit({
      Kind: 'PRIVMSG', From: f, Target: '#dev', Message: t,
      Tags: { time: new Date().toISOString(), msgid: id }, Raw: '',
    });
  }, [msgid, from, text] as const);
  await emit('w-1', 'jrmu', 'screenshot of the bug https://img.test/wide.png');
  await emit('w-2', 'kestrel', 'and the tall one https://img.test/tall.png');
  await emit('w-3', 'mox', `log: https://files.example/${'a1b2c3d4'.repeat(24)}/build.log`);
  await expect.poll(() => list(page).evaluate((el) => {
    const frames = Array.from(el.querySelectorAll('.img-frame'));
    return frames.length >= 2 && frames.every((f) => f.getAttribute('data-state') === 'loaded');
  }), { timeout: 10_000 }).toBe(true);
  await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
}

// Nothing sticks out of its column, and nothing scrolls sideways.
async function checkFits(page: Page): Promise<void> {
  const m = await list(page).evaluate((el) => {
    const out: string[] = [];
    for (const f of Array.from(el.querySelectorAll<HTMLElement>('.img-frame, .embed, .msg-embeds, .message-row-text-body'))) {
      const body = f.closest('.message-row-body')!.getBoundingClientRect();
      const r = f.getBoundingClientRect();
      if (r.right > body.right + 0.5) out.push(`${f.className} ${r.right} > ${body.right}`);
    }
    el.scrollLeft = 400;
    return { out, scrollLeft: el.scrollLeft, sw: el.scrollWidth, cw: el.clientWidth };
  });
  expect(m.out).toEqual([]);
  expect(m.scrollLeft).toBe(0);
  expect(m.sw).toBeLessThanOrEqual(m.cw);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

// The wide image keeps its shape inside its frame (scaled, not cropped).
async function wideImage(page: Page) {
  const img = rowWith(page, 'screenshot of the bug').locator('.img-frame-img');
  await expect(img).toBeVisible();
  return img.evaluate((el: HTMLImageElement) => {
    const r = el.getBoundingClientRect();
    const body = el.closest('.message-row-body')!.getBoundingClientRect();
    return { w: r.width, h: r.height, body: body.width, natural: el.naturalWidth / el.naturalHeight };
  });
}

for (const vp of [{ name: 'phone', width: 390, height: 760 }, { name: 'desktop', width: 1280, height: 800 }]) {
  test(`image previews fit the message column (${vp.name})`, async ({ page }) => {
    await open(page, vp.width, vp.height);
    await checkFits(page);
    const w = await wideImage(page);
    expect(w.w).toBeLessThanOrEqual(w.body);
    if (vp.name === 'desktop') expect(w.w).toBeLessThanOrEqual(422);
    await page.screenshot({ path: test.info().outputPath(`${vp.name}-first.png`) });

    // Again with the sizes known (the box reserved before load, #155): a
    // width and an aspect ratio, scaled down evenly to the column. (The
    // sizes are saved a second after they're learnt.)
    await page.waitForTimeout(1300);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await open(page, vp.width, vp.height);
    await expect(rowWith(page, 'screenshot of the bug').locator('.img-frame')).toHaveAttribute('data-reserved', 'known');
    await checkFits(page);
    const frame = await rowWith(page, 'screenshot of the bug').locator('.img-frame').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width - 2, h: r.height - 2 };
    });
    expect(Math.abs(frame.w / frame.h - 3000 / 800)).toBeLessThan(0.1);
    const tall = await rowWith(page, 'and the tall one').locator('.img-frame').boundingBox();
    expect(tall!.height).toBeLessThanOrEqual(285); // 280 + border + rounding
    await rowWith(page, 'screenshot of the bug').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`${vp.name}-known.png`) });
  });
}
