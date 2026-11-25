// The message list holds still: images arriving late don't move what's on
// screen (their frame is sized before they load), the list stays at the
// bottom when it was there, the user's own scroll isn't pulled back or
// jumped, and the composer growing or a multi-line message sent never
// hides the newest lines behind it.
import { expect, test, type Page, type Route } from '@playwright/test';

// Images of a few shapes, as SVG (any URL ending .png is an image embed).
const SHAPES = [
  { w: 1200, h: 800 },
  { w: 400, h: 900 },
  { w: 1600, h: 400 },
  { w: 80, h: 60 },
];
function svg(n: number): string {
  const { w, h } = SHAPES[n % SHAPES.length]!;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<rect width="${w}" height="${h}" fill="hsl(${(n * 47) % 360} 55% 45%)"/>`
    + `<text x="50%" y="50%" font-size="${Math.round(h / 5)}" text-anchor="middle" dominant-baseline="middle" fill="#fff">${n}</text></svg>`;
}

// Serves img.test's images only once release() is called: the list first
// lays out with every image still loading.
async function holdImages(page: Page): Promise<{ release: () => void; served: () => number }> {
  let open = false;
  let count = 0;
  const waiting: Array<() => void> = [];
  const serve = (route: Route): void => {
    const n = Number(/pic-(\d+)/.exec(route.request().url())?.[1] ?? 0);
    count++;
    void route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(n), headers: { 'Cache-Control': 'no-store' } });
  };
  await page.route('https://img.test/**', (route) => {
    if (open) serve(route);
    else waiting.push(() => serve(route));
  });
  return {
    release: () => { open = true; for (const w of waiting.splice(0)) w(); },
    served: () => count,
  };
}

const list = (page: Page) => page.locator('main .chat-messages');

async function metrics(page: Page) {
  return list(page).evaluate((el) => {
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.vrow'));
    const last = rows[rows.length - 1]!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const composer = document.querySelector('.chat-input-bar')!.getBoundingClientRect();
    return {
      top: el.scrollTop,
      gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      lastBottom: last.bottom,
      listBottom: box.bottom,
      composerTop: composer.top,
    };
  });
}

// Where a row (by message id) is on screen.
const rowTop = (page: Page, key: string) => list(page).evaluate((el, k) => {
  const row = el.querySelector<HTMLElement>(`.vrow[data-vkey="${k}"]`);
  return row ? row.getBoundingClientRect().top : null;
}, key);

// Every image frame in the DOM has its image.
async function allLoaded(page: Page): Promise<void> {
  await expect.poll(() => list(page).evaluate((el) => {
    const frames = Array.from(el.querySelectorAll('.img-frame'));
    return frames.length > 0 && frames.every((f) => f.getAttribute('data-state') === 'loaded');
  }), { timeout: 10_000 }).toBe(true);
}

// The message id of the row nearest the middle of the viewport.
const middleKey = (page: Page) => list(page).evaluate((el) => {
  const box = el.getBoundingClientRect();
  const mid = box.top + box.height / 2;
  let best: { key: string; d: number } | null = null;
  for (const r of Array.from(el.querySelectorAll<HTMLElement>('.vrow'))) {
    const rb = r.getBoundingClientRect();
    const d = Math.abs(rb.top - mid);
    if (rb.bottom > box.top && rb.top < box.bottom && (!best || d < best.d)) best = { key: r.dataset['vkey']!, d };
  }
  return best!.key;
});

test.describe('chat scroll stability', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('images arriving late move nothing on screen, scrolled up or at the bottom', async ({ page }) => {
    const imgs = await holdImages(page);
    await page.goto('/shots.html?view=chat&frame=1&scroll=60', { waitUntil: 'domcontentloaded' });
    await expect(list(page).locator('.img-frame').first()).toBeVisible();
    // Loading: frames with the shimmer, already their full height.
    await expect(list(page).locator('.img-frame[data-state="loading"] .img-frame-bar').first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('images-loading.png') });

    // At the bottom (the last line is an image): still at the bottom once
    // they're in.
    expect((await metrics(page)).gap).toBeLessThanOrEqual(1);
    imgs.release();
    await allLoaded(page);
    await page.waitForTimeout(200);
    expect((await metrics(page)).gap).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath('images-loaded-bottom.png') });
  });

  test('scrolled up to the middle: the line being read stays put while images load', async ({ page }) => {
    const imgs = await holdImages(page);
    await page.goto('/shots.html?view=chat&frame=1&scroll=60', { waitUntil: 'domcontentloaded' });
    await expect(list(page).locator('.img-frame').first()).toBeVisible();
    // To the middle, with the wheel (the user's own scroll).
    const box = (await list(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const target = await list(page).evaluate((el) => (el.scrollHeight - el.clientHeight) / 2);
    for (let i = 0; i < 60 && (await list(page).evaluate((el) => el.scrollTop)) > target; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(400); // scrolling settled
    expect(await list(page).locator('.img-frame[data-state="loading"]').count()).toBeGreaterThan(0);
    const key = await middleKey(page);
    const before = (await rowTop(page, key))!;
    imgs.release();
    await allLoaded(page);
    await page.waitForTimeout(300);
    const after = (await rowTop(page, key))!;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
    expect((await metrics(page)).gap).toBeGreaterThan(100); // not pulled to the bottom
    await page.screenshot({ path: test.info().outputPath('images-loaded-middle.png') });
  });

  test("a slow scroll up from the bottom isn't pulled back down", async ({ page }) => {
    const imgs = await holdImages(page);
    imgs.release();
    await page.goto('/shots.html?view=chat&frame=1&scroll=60', { waitUntil: 'domcontentloaded' });
    await expect(list(page).locator('.vrow').first()).toBeVisible();
    await page.waitForTimeout(300);
    const start = await metrics(page);
    expect(start.gap).toBeLessThanOrEqual(1);
    const box = (await list(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // A trackpad's few pixels at a time, each well inside the at-bottom slack.
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, -4);
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(300);
    const end = await metrics(page);
    expect(start.top - end.top).toBeGreaterThanOrEqual(40);
    expect(end.gap).toBeGreaterThanOrEqual(40);
  });

  test('scrolling back through history: nothing jumps when the scroll stops', async ({ page }) => {
    const imgs = await holdImages(page);
    imgs.release();
    await page.goto('/shots.html?view=chat&frame=1&scroll=200', { waitUntil: 'domcontentloaded' });
    await expect(list(page).locator('.vrow').first()).toBeVisible();
    await page.waitForTimeout(300);
    const box = (await list(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Up through rows never laid out before (their heights are estimates
    // until they come near): each comes in measured mid-scroll.
    for (let i = 0; i < 25; i++) {
      await page.mouse.wheel(0, -160);
      await page.waitForTimeout(16);
    }
    const key = await middleKey(page);
    const before = (await rowTop(page, key))!;
    await page.waitForTimeout(500); // the scroll has stopped: the list settles
    const after = (await rowTop(page, key))!;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    // Settled: the spacer above stands for exactly the rows it replaces
    // (scrolling on to the top reaches the first line).
    await list(page).evaluate((el) => { el.scrollTop = 0; });
    await expect(list(page).getByText('morning all — pushed the new directory build last night')).toBeVisible();
  });

  test('the composer growing keeps the newest line above it', async ({ page }) => {
    await page.goto('/shots.html?view=chat&frame=1');
    await expect(list(page).locator('.vrow').first()).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: test.info().outputPath('composer-before.png') });
    const ta = page.locator('textarea.chat-textarea');
    await ta.click();
    for (const l of ['first line', 'second line', 'third line']) {
      await ta.pressSequentially(l);
      await ta.press('Shift+Enter');
    }
    await ta.pressSequentially('fourth line');
    const m = await metrics(page);
    expect(m.gap).toBeLessThanOrEqual(1); // still at the bottom
    expect(m.lastBottom).toBeLessThanOrEqual(m.composerTop);
    expect(m.lastBottom).toBeLessThanOrEqual(m.listBottom);
    await page.screenshot({ path: test.info().outputPath('composer-four-lines.png') });

    // Sent: the whole message shows, above the (one-line again) composer.
    await ta.press('Enter');
    await expect(list(page).getByText('fourth line')).toBeVisible();
    await page.waitForTimeout(300);
    const s = await metrics(page);
    expect(s.gap).toBeLessThanOrEqual(1);
    const sent = list(page).locator('.vrow').last();
    await expect(sent).toContainText('fourth line');
    await expect(list(page).getByText('first line')).toBeInViewport();
    const sb = (await sent.boundingBox())!;
    expect(sb.y + sb.height).toBeLessThanOrEqual(s.listBottom + 0.5);
    expect(sb.y + sb.height).toBeLessThanOrEqual(s.composerTop);
    await page.screenshot({ path: test.info().outputPath('composer-sent.png') });
  });

  test('phone: the composer growing keeps the newest line above it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/shots.html?view=chat&frame=1&platform=ios');
    await expect(list(page).locator('.vrow').first()).toBeVisible();
    await page.waitForTimeout(300);
    const ta = page.locator('textarea.chat-textarea');
    await ta.click();
    for (const l of ['first line', 'second line', 'third line']) {
      await ta.pressSequentially(l);
      await ta.press('Shift+Enter');
    }
    await ta.pressSequentially('fourth line');
    const m = await metrics(page);
    expect(m.gap).toBeLessThanOrEqual(1);
    expect(m.lastBottom).toBeLessThanOrEqual(m.composerTop);
    await page.screenshot({ path: test.info().outputPath('phone-composer-four-lines.png') });
  });
});
