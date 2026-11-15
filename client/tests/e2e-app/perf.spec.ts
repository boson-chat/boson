// Performance measurements of the message view and image loading, against
// the real app (server-mode build in Chromium). Not part of the regular run:
// set E2E_PERF=1. Prints one JSON line per measurement ("[perf] {...}") and
// attaches the lot to the report.
//
//   cd client && E2E_PERF=1 npx playwright test -c playwright.app.config.ts perf.spec.ts --workers=1
//
// What it measures (the PR's before/after table):
//   - opening a channel that holds 1500 messages (click → last message
//     painted), median of 5;
//   - DOM nodes in the page / in the message list once it's open;
//   - JS heap (after a forced GC) once the user scrolled to the very top of
//     that history and back down, and how smooth the scroll was (frame times);
//   - how long an image takes to show: first time (network, with 300 ms of
//     added latency), after switching away and back, and after a relaunch.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync, crc32 } from 'node:zlib';
import type { Page } from '@playwright/test';
import { test, expect, randomChannel, type Profile } from './fixtures';
import type { App } from './desktop-app';
import { connectGuest, connectPeer, conversation, messages, memberRow, joinViaUi } from './helpers/chat';
import type { IrcPeer } from './irc-peer';

test.skip(!process.env['E2E_PERF'], 'perf measurements: set E2E_PERF=1');
test.describe.configure({ mode: 'serial' });

const HISTORY = 1500;
const LATENCY_MS = 300;

// A w×h PNG of noise-ish pixels (doesn't compress away): a realistic size
// for a photo-like image without shipping one.
function png(w: number, h: number, seed: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = seed >>> 0 || 1;
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let i = 0; i < w * 3; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      // Smooth-ish gradient plus noise.
      raw[row + 1 + i] = ((i / 3 + y) & 0xff) ^ (x & 0x3f);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Site { port: number; hits: string[]; close: () => Promise<void> }

async function startImageSite(): Promise<Site> {
  const images = new Map<string, Buffer>();
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits.push(req.url ?? '/');
    const m = /^\/img\/(\w+)\.png$/.exec(path);
    if (!m) { res.writeHead(404); res.end(); return; }
    let body = images.get(m[1]!);
    if (!body) {
      // "big*" images are photo-sized; the rest small.
      body = m[1]!.startsWith('big') ? png(1600, 1000, m[1]!.length * 7919) : png(320, 200, m[1]!.length * 31);
      images.set(m[1]!, body);
    }
    const etag = `"${m[1]}"`;
    setTimeout(() => {
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
      res.writeHead(200, {
        'content-type': 'image/png', 'content-length': body!.length,
        'cache-control': 'public, max-age=3600', ETag: etag,
      });
      res.end(body);
    }, LATENCY_MS);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

// Seeding pauses every 100 lines: unpaced, a few thousand lines at once
// overflow the IRC server's send queue to the app (it then drops the app's
// connection), with or without these changes.
const pace = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

function report(name: string, data: Record<string, unknown>): void {
  console.log(`[perf] ${JSON.stringify({ name, ...data })}`);
  test.info().annotations.push({ type: 'perf', description: JSON.stringify({ name, ...data }) });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

// Clicks a sidebar conversation and resolves when `lastText` is in the
// message list and two frames have painted. Measured in the page.
async function timeOpen(page: Page, name: string, lastText: string): Promise<number> {
  const item = conversation(page, name);
  await item.waitFor();
  const handle = await item.elementHandle();
  return page.evaluate(async ({ el, lastText }) => {
    const t0 = performance.now();
    (el as HTMLElement).click();
    await new Promise<void>((resolve) => {
      const check = (): boolean => {
        const list = document.querySelector('main .chat-messages');
        return !!list && (list.textContent ?? '').includes(lastText);
      };
      if (check()) { resolve(); return; }
      const mo = new MutationObserver(() => { if (check()) { mo.disconnect(); resolve(); } });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  }, { el: handle, lastText });
}

async function domCounts(page: Page): Promise<{ page: number; list: number; rows: number; imgs: number }> {
  return page.evaluate(() => {
    const list = document.querySelector('main .chat-messages');
    return {
      page: document.getElementsByTagName('*').length,
      list: list ? list.getElementsByTagName('*').length : 0,
      rows: list ? list.querySelectorAll('.message-row, .message-system, .message-action').length : 0,
      imgs: list ? list.querySelectorAll('img').length : 0,
    };
  });
}

async function heapMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  await cdp.detach();
  return Math.round((usedSize / 1048576) * 10) / 10;
}

// Resident memory (MB) of the Go shell (the app process) and of the
// renderer (Chromium's renderer processes for this profile's browser).
function rssMB(app: App, profile: Profile): { shell: number; renderer: number } {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const dir = join(profile.userData, 'browser');
  const procs = out.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((m) => !!m)
    .map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), rss: Number(m![3]), cmd: m![4]! }));
  // The browser: the process started with this profile's user data dir;
  // its renderers are its children with --type=renderer.
  const browsers = new Set(procs.filter((p) => p.cmd.includes(dir) && !p.cmd.includes('--type=')).map((p) => p.pid));
  const shell = procs.find((p) => p.pid === app.process().pid)?.rss ?? 0;
  const renderer = procs.filter((p) => browsers.has(p.ppid) && p.cmd.includes('--type=renderer')).reduce((n, p) => n + p.rss, 0);
  const mb = (kb: number): number => Math.round(kb / 102.4) / 10;
  return { shell: mb(shell), renderer: mb(renderer) };
}

// Scroll the list to the very top (loading older pages as they come), then
// back to the bottom, a step per frame, like a fast wheel. Returns frame
// stats from requestAnimationFrame deltas.
async function scrollThrough(page: Page): Promise<{ upMs: number; downMs: number; frames: number; p95: number; long: number; topReached: boolean }> {
  return page.evaluate(async () => {
    const list = document.querySelector('main .chat-messages') as HTMLElement;
    const deltas: number[] = [];
    let last = performance.now();
    let on = true;
    const tick = (t: number): void => { deltas.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
    const t0 = performance.now();
    let stuck = 0;
    let topReached = false;
    while (performance.now() - t0 < 120_000) {
      const before = list.scrollTop;
      list.scrollTop = Math.max(0, list.scrollTop - 400);
      list.dispatchEvent(new Event('scroll'));
      await frame();
      if (list.scrollTop <= 0 && before <= 0) {
        // At the top: wait for an older page (or the end of history).
        const h = list.scrollHeight;
        await new Promise((r) => setTimeout(r, 400));
        const end = !!document.querySelector('main .chat-load-older-end');
        if (list.scrollHeight === h) { stuck++; if (stuck >= 4 || end) { topReached = true; break; } } else stuck = 0;
      }
    }
    const t1 = performance.now();
    while (list.scrollTop + list.clientHeight < list.scrollHeight - 2) {
      list.scrollTop += 400;
      list.dispatchEvent(new Event('scroll'));
      await frame();
      if (performance.now() - t1 > 60_000) break;
    }
    const t2 = performance.now();
    on = false;
    const s = deltas.slice(2).sort((a, b) => a - b);
    return {
      upMs: Math.round(t1 - t0),
      downMs: Math.round(t2 - t1),
      frames: s.length,
      p95: Math.round(s[Math.floor(s.length * 0.95)] ?? 0),
      long: s.filter((d) => d > 50).length,
      topReached,
    };
  });
}

// Waits for an <img> inside the row holding `text` to be decoded; returns ms
// from `t0` (a performance.now() in the page) or from when called.
async function imageShownAfter(page: Page, text: string, start: 'now' | number): Promise<number> {
  return page.evaluate(async ({ text, start }) => {
    const t0 = start === 'now' ? performance.now() : start;
    for (;;) {
      const rows = Array.from(document.querySelectorAll('main .chat-messages .message-row'));
      const row = rows.find((r) => (r.textContent ?? '').includes(text));
      const img = row?.querySelector('img.embed-img') as HTMLImageElement | null | undefined;
      if (img && img.complete && img.naturalWidth > 0) return performance.now() - t0;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  }, { text, start });
}

test.describe('perf', () => {
  let peers: IrcPeer[] = [];
  let site: Site | null = null;
  test.beforeEach(async () => { site = await startImageSite(); });
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
    await site?.close();
  });

  test(`a channel with ${HISTORY} messages: open, DOM, scroll, heap`, async ({ launchApp, profile }) => {
    test.setTimeout(600_000);
    const big = randomChannel('perf');
    const other = randomChannel('other');
    const peer = await connectPeer();
    peers.push(peer);
    const { app, page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, big, nick);
    await peer.join(big);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    await joinViaUi(page, other, nick);
    await peer.join(other);
    await expect(memberRow(page, peer.nick)).toBeVisible();

    // History lands while another channel is open (how a busy channel fills
    // up in the background). Some lines carry markdown, links and images.
    const s = site!;
    const t0 = Date.now();
    for (let i = 1; i <= HISTORY; i++) {
      let line = `line ${i} — the quick brown fox jumps over the lazy dog`;
      if (i % 7 === 0) line += ' and **bold** with `code` in it';
      if (i % 11 === 0) line += ` see #${other.slice(1)} and @someone`;
      if (i % 13 === 0) line = `line ${i} ${'a longer message that wraps over a couple of lines in the list; '.repeat(3)}`;
      if (i % 50 === 0) line = `line ${i} pic http://127.0.0.1:${s.port}/img/h${i}.png`;
      peer.privmsg(big, line);
      if (i % 100 === 0) await pace();
    }
    peer.privmsg(other, 'history sent');
    await expect(messages(page).getByText('history sent')).toBeVisible({ timeout: 300_000 });
    report('ingest', { messages: HISTORY, ms: Date.now() - t0 });

    // Open it (×5: back to the other channel between runs).
    const lastText = `line ${HISTORY} pic`;
    const opens: number[] = [];
    for (let i = 0; i < 5; i++) {
      opens.push(await timeOpen(page, big, lastText));
      if (i === 0) {
        await page.waitForTimeout(1500);
        report('dom-open', await domCounts(page));
        await page.screenshot({ path: test.info().outputPath('open.png') });
      }
      await timeOpen(page, other, 'history sent');
    }
    report('open-channel', { runs: opens.map(Math.round), medianMs: Math.round(median(opens)) });

    await timeOpen(page, big, lastText);
    await page.waitForTimeout(1000);
    report('heap-open', { mb: await heapMB(page) });
    const scroll = await scrollThrough(page);
    report('scroll', scroll);
    await page.screenshot({ path: test.info().outputPath('after-scroll.png') });
    await page.waitForTimeout(1500);
    report('dom-after-scroll', await domCounts(page));
    report('heap-after-scroll', { mb: await heapMB(page), rss: rssMB(app, profile) });
    const nodes = await page.evaluate(() => document.querySelector('main .chat-messages')?.textContent?.includes('line 1 —') ?? false);
    report('top-in-dom-after-return', { present: nodes });
  });

  // A long session: several busy channels full of images, each opened and
  // scrolled from the bottom to the very top and back, three rounds; heap
  // and RSS after each. The goal: low, and flat from round to round.
  test('long session: 4 channels × 1500 messages with images, 3 rounds of scrolling', async ({ launchApp, profile }) => {
    test.setTimeout(1_200_000);
    const s = site!;
    const peer = await connectPeer();
    peers.push(peer);
    const { app, page, nick } = await connectGuest(launchApp);
    const chans = [randomChannel('la'), randomChannel('lb'), randomChannel('lc'), randomChannel('ld')];
    for (const c of chans) {
      await joinViaUi(page, c, nick);
      await peer.join(c);
      await expect(memberRow(page, peer.nick)).toBeVisible();
    }
    for (const [ci, c] of chans.entries()) {
      for (let i = 1; i <= HISTORY; i++) {
        let line = `k${ci} line ${i} — the quick brown fox jumps over the lazy dog`;
        if (i % 25 === 0) line = `k${ci} line ${i} pic http://127.0.0.1:${s.port}/img/${i % 100 === 0 ? 'big' : 's'}${ci}x${i}.png`;
        peer.privmsg(c, line);
        if (i % 100 === 0) await pace();
      }
    }
    await expect(messages(page).getByText(`k${chans.length - 1} line ${HISTORY} pic`)).toBeVisible({ timeout: 300_000 });
    await page.waitForTimeout(3000);
    const series: Array<Record<string, number>> = [];
    const sample = async (round: number): Promise<void> => {
      await page.waitForTimeout(1500);
      const heap = await heapMB(page);
      series.push({ round, heapMB: heap, ...rssMB(app, profile), domNodes: (await domCounts(page)).page });
    };
    await sample(0);
    for (let round = 1; round <= 3; round++) {
      for (const [ci, c] of chans.entries()) {
        await timeOpen(page, c, `k${ci} line ${HISTORY} pic`);
        await page.waitForTimeout(500);
        await scrollThrough(page);
      }
      await sample(round);
    }
    report('long-session', { channels: chans.length, perChannel: HISTORY, series });
  });

  test('image: network vs. cached (switch back, relaunch)', async ({ launchApp, profile }) => {
    test.setTimeout(300_000);
    const ch = randomChannel('img');
    const other = randomChannel('other');
    const peer = await connectPeer();
    peers.push(peer);
    const s = site!;
    const first = await connectGuest(launchApp);
    let page = first.page;
    await joinViaUi(page, other, first.nick);
    await joinViaUi(page, ch, first.nick);
    await peer.join(ch);
    await peer.join(other);
    await expect(memberRow(page, peer.nick)).toBeVisible();

    const results: Record<string, number[]> = { network: [], switchBack: [], relaunch: [] };
    for (const name of ['big1', 'big2', 'big3']) {
      // Network: from the message showing up to the image painted.
      const start = await page.evaluate(() => performance.now());
      peer.privmsg(ch, `pic ${name} http://127.0.0.1:${s.port}/img/${name}.png`);
      results.network!.push(await imageShownAfter(page, `pic ${name}`, start));
    }
    for (let i = 0; i < 3; i++) {
      await timeOpen(page, other, other.slice(1)).catch(() => 0);
      await conversation(page, other).click();
      await page.waitForTimeout(300);
      const start = await page.evaluate(() => performance.now());
      await conversation(page, ch).click();
      for (const name of ['big1', 'big2', 'big3']) results.switchBack!.push(await imageShownAfter(page, `pic ${name}`, start));
    }
    const hitsBefore = s.hits.length;
    await first.app.close();
    // Relaunch: same profile, the renderer starts empty.
    const second = await launchApp({ profile });
    page = second.page;
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    // A guest's messages live in memory only: post them again, same URLs.
    await conversation(page, ch).click();
    await expect(memberRow(page, peer.nick)).toBeVisible({ timeout: 30_000 });
    const hitsRelaunch = s.hits.length;
    for (const name of ['big1', 'big2', 'big3']) {
      const start = await page.evaluate(() => performance.now());
      peer.privmsg(ch, `again ${name} http://127.0.0.1:${s.port}/img/${name}.png`);
      results.relaunch!.push(await imageShownAfter(page, `again ${name}`, start));
    }
    // A webview that keeps no HTTP cache of its own across launches (or one
    // that has evicted it): the browser cache off, the shell's (if any) on.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const hitsNoCache = s.hits.length;
    results.noBrowserCache = [];
    for (const name of ['big1', 'big2', 'big3']) {
      const start = await page.evaluate(() => performance.now());
      peer.privmsg(ch, `nocache ${name} http://127.0.0.1:${s.port}/img/${name}.png`);
      results.noBrowserCache.push(await imageShownAfter(page, `nocache ${name}`, start));
    }
    await cdp.detach();
    report('image', {
      latencyMs: LATENCY_MS,
      networkMs: results.network!.map(Math.round),
      switchBackMs: results.switchBack!.map(Math.round),
      relaunchMs: results.relaunch!.map(Math.round),
      noBrowserCacheMs: results.noBrowserCache.map(Math.round),
      medians: {
        noBrowserCache: Math.round(median(results.noBrowserCache)),
        network: Math.round(median(results.network!)),
        switchBack: Math.round(median(results.switchBack!)),
        relaunch: Math.round(median(results.relaunch!)),
      },
      siteHits: { firstLaunch: hitsBefore, relaunch: hitsNoCache - hitsRelaunch, noBrowserCache: s.hits.length - hitsNoCache },
    });
  });
});
