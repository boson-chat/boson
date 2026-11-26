// Threads and wide image previews on a phone (the mobile project: an
// iPhone's viewport, with touch; on the web also in WebKit), against the e2e
// ergo:
//   - a tap on a thread's counter line ("1 reply · View thread") opens the
//     thread's full-height sheet, and so does "View thread" in a message's
//     long-press sheet. On an iPhone the tap once did nothing: the line's
//     :hover swapped "last reply …" for "View thread", and iOS takes a tap
//     that shows or hides content on hover as "hover first" and drops the
//     click. Nothing in the line may change on hover where hover is none;
//   - a very wide image (3000×800) stays inside the message column, and the
//     message list never scrolls sideways.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { test, expect, randomChannel, joinChannel, IS_WEB } from './fixtures';
import { E2E_BIND_HOST } from './web-server';
import { connectGuest, connectPeer, messages } from './helpers/chat';
import type { IrcPeer } from './irc-peer';

// A solid-colour RGB PNG of w×h.
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([0x3a, 0x6e, 0xa5], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const row = (page: Page, text: string) => messages(page).locator('.message-row')
  .filter({ has: page.locator('.message-row-text-body', { hasText: text }) });
const sheet = (page: Page) => page.locator('.thread-panel-sheet');

async function openChannel(page: Page, ch: string): Promise<void> {
  const back = page.getByRole('button', { name: 'Back to channels' });
  if (await back.isVisible()) await back.click();
  await joinChannel(page, ch);
  await expect(page.locator('.app-shell')).toHaveClass(/\bphone-chat\b/);
}

test.describe('phone: threads and wide previews', () => {
  let peers: IrcPeer[] = [];
  let server: Server | null = null;
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  test('a tap on the counter line opens the thread; so does the long-press sheet', async ({ launchApp }) => {
    const channel = randomChannel('pthread');
    const peer = await connectPeer(undefined, ['message-tags', 'echo-message']);
    peers.push(peer);
    const { page } = await connectGuest(launchApp);
    await openChannel(page, channel);
    await peer.join(channel);

    const mark = peer.mark();
    peer.privmsg(channel, 'pt1 sounds good');
    const echo = await peer.waitFor((l) => l.command === 'PRIVMSG' && l.params[1] === 'pt1 sounds good', 15_000, 'echo', mark);
    const rootId = echo.tags['msgid'];
    expect(rootId).toBeTruthy();
    peer.send(`@+draft/reply=${rootId} PRIVMSG ${channel} :pt2 see you at 4`);
    await expect(row(page, 'pt2 see you at 4')).toBeVisible();

    const line = row(page, 'pt1 sounds good').locator('.message-thread-line');
    await expect(line).toContainText('1 reply');
    // A real button; where hover is none (a phone; Firefox's emulation
    // keeps a hovering pointer) "View thread" shows from the start and
    // nothing in the line changes on hover.
    await expect(line).toHaveJSProperty('tagName', 'BUTTON');
    if (await page.evaluate(() => matchMedia('(hover: none)').matches)) {
      await expect(line.locator('.message-thread-view')).toBeVisible();
      const shown = () => line.evaluate((el) => Array.from(el.querySelectorAll('*'))
        .map((c) => { const s = getComputedStyle(c); return `${s.display}/${s.visibility}/${s.opacity}`; }).join(','));
      const before = await shown();
      await line.hover();
      expect(await shown()).toBe(before);
    }

    // Tap: the thread's sheet, full height.
    await line.tap();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator('.message-row').first()).toContainText('pt1 sounds good');
    await expect(sheet(page).locator('.message-row').nth(1)).toContainText('pt2 see you at 4');
    const vp = page.viewportSize()!;
    expect((await sheet(page).boundingBox())!.height).toBeGreaterThan(vp.height - 2);
    await sheet(page).getByRole('button', { name: 'Close thread' }).tap();
    await expect(sheet(page)).toHaveCount(0);

    // A long press on the reply: its sheet's "View thread".
    const reply = row(page, 'pt2 see you at 4');
    const box = (await reply.boundingBox())!;
    const at = { identifier: 0, clientX: box.x + 40, clientY: box.y + 10 };
    await reply.dispatchEvent('touchstart', { touches: [at], targetTouches: [at], changedTouches: [at] });
    await page.waitForTimeout(650);
    await reply.dispatchEvent('touchend', { changedTouches: [at] });
    await page.getByRole('menuitem', { name: 'View thread' }).tap();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator('.message-row').first()).toContainText('pt1 sounds good');
  });

  test('a very wide image stays in the column; the list never scrolls sideways', async ({ launchApp }) => {
    const wide = png(3000, 800);
    server = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/wide.png')) {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': wide.length });
        res.end(wide);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, IS_WEB ? E2E_BIND_HOST : '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const channel = randomChannel('pwide');
    const peer = await connectPeer();
    peers.push(peer);
    const { page } = await connectGuest(launchApp);
    await openChannel(page, channel);
    await peer.join(channel);
    peer.privmsg(channel, `pw1 screenshot http://127.0.0.1:${port}/wide.png`);
    peer.privmsg(channel, `pw2 log https://files.example/${'a1b2c3d4'.repeat(24)}/build.log`);
    const frame = row(page, 'pw1 screenshot').locator('.img-frame');
    await expect(frame).toHaveAttribute('data-state', 'loaded', { timeout: 20_000 });
    await expect(row(page, 'pw2 log')).toBeVisible();

    const m = await messages(page).evaluate((el) => {
      const out: string[] = [];
      for (const f of Array.from(el.querySelectorAll<HTMLElement>('.img-frame, .embed, .message-row-text-body'))) {
        const body = f.closest('.message-row-body')!.getBoundingClientRect();
        const r = f.getBoundingClientRect();
        if (r.right > body.right + 0.5) out.push(`${f.className}: ${r.right} > ${body.right}`);
      }
      el.scrollLeft = 400;
      return { out, scrollLeft: el.scrollLeft, sw: el.scrollWidth, cw: el.clientWidth };
    });
    expect(m.out).toEqual([]);
    expect(m.scrollLeft).toBe(0);
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The image itself: inside the frame, its shape kept.
    const img = await frame.locator('img').evaluate((el: HTMLImageElement) => ({ nw: el.naturalWidth, nh: el.naturalHeight }));
    expect(img.nw / img.nh).toBeGreaterThan(3);
  });
});
