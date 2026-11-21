// The image cache (desktop/imagecache.go + shared/image-cache.ts): an image
// seen once shows again when the user comes back to it, and after a
// relaunch, from the shell's disk cache without asking its host again; a stale one is
// revalidated (a 304 keeps the stored copy). Big images show as a
// thumbnail inline (the shell scales them down once), the full image in the
// lightbox.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync, crc32 } from 'node:zlib';
import { test, expect, randomChannel, webSkip } from './fixtures';

webSkip("the desktop image disk cache (desktop/imagecache.go); the web uses the browser cache");
import { connectGuest, connectPeer, conversation, joinViaUi, memberRow, messages } from './helpers/chat';
import type { IrcPeer } from './irc-peer';

// A w×h PNG of noise (so it doesn't compress to nothing).
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = 2463534242;
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    raw[i] = i % (w * 3 + 1) === 0 ? 0 : x & 0xff;
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Site { port: number; hits: Array<{ path: string; conditional: boolean }>; close: () => Promise<void> }

async function startSite(): Promise<Site> {
  const small = png(64, 48);
  const big = png(1600, 1000);
  const hits: Site['hits'] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const conditional = !!req.headers['if-none-match'];
    hits.push({ path, conditional });
    const body = path.startsWith('/big') ? big : small;
    // /fresh*: an hour; /stale*: revalidate every time (ETag).
    const fresh = !path.startsWith('/stale');
    const etag = `"${path}"`;
    if (!fresh && req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': body.length,
      'cache-control': fresh ? 'public, max-age=3600' : 'no-cache',
      ETag: etag,
    });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

test.describe('image cache', () => {
  let peers: IrcPeer[] = [];
  let site: Site | null = null;
  test.beforeEach(async () => { site = await startSite(); });
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
    await site?.close();
  });

  test('an image comes from memory on the second view, from disk after a relaunch; stale ones are revalidated', async ({ launchApp, profile }) => {
    test.setTimeout(180_000);
    const s = site!;
    const ch = randomChannel('imgc');
    const other = randomChannel('other');
    const peer = await connectPeer();
    peers.push(peer);
    const first = await connectGuest(launchApp);
    let page = first.page;
    await joinViaUi(page, other, first.nick);
    await joinViaUi(page, ch, first.nick);
    await peer.join(ch);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    const img = (text: string) => messages(page).locator('.message-row').filter({ hasText: text }).locator('img.embed-img');
    const hitsOf = (p: string) => s.hits.filter((h) => h.path === p);

    // What the shell says about an <img>'s answer (X-Boson-Cache).
    const shellCache = (text: string) => img(text).evaluate(async (i: HTMLImageElement) =>
      (await fetch(i.src, { method: 'HEAD' })).headers.get('X-Boson-Cache'));
    const width = (text: string) => img(text).evaluate((i: HTMLImageElement) => i.naturalWidth);

    // First view: fetched once, streamed from the app's own origin.
    const fresh = `http://127.0.0.1:${s.port}/fresh.png`;
    const stale = `http://127.0.0.1:${s.port}/stale.png`;
    peer.privmsg(ch, `one ${fresh}`);
    peer.privmsg(ch, `two ${stale}`);
    await expect(img('one')).toHaveAttribute('src', /^\/_boson\/img\?k=web&/);
    await expect.poll(() => width('one')).toBe(64);
    await expect.poll(() => width('two')).toBe(64);
    expect(hitsOf('/fresh.png')).toHaveLength(1);
    expect(await shellCache('one')).toBe('hit');

    // Away and back: shown again without asking the host for the fresh one;
    // the no-cache one only conditionally.
    await conversation(page, other).click();
    await expect(messages(page).locator('img.embed-img')).toHaveCount(0);
    await conversation(page, ch).click();
    await expect.poll(() => width('one')).toBe(64);
    await expect.poll(() => width('two')).toBe(64);
    expect(hitsOf('/fresh.png')).toHaveLength(1);
    expect(hitsOf('/stale.png').slice(1).every((h) => h.conditional)).toBe(true);

    // Relaunch: the page starts empty; the shell answers from disk.
    await first.app.close();
    const staleBefore = hitsOf('/stale.png').length;
    const second = await launchApp({ profile });
    page = second.page;
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await conversation(page, ch).click();
    await expect(memberRow(page, peer.nick)).toBeVisible({ timeout: 30_000 });
    peer.privmsg(ch, `third ${fresh}`);
    peer.privmsg(ch, `stale again ${stale}`);
    await expect.poll(() => width('third')).toBe(64);
    await expect.poll(() => width('stale again')).toBe(64);
    expect(hitsOf('/fresh.png')).toHaveLength(1);
    expect(await shellCache('third')).toBe('hit');
    // no-cache: asked again, conditionally, and a 304 kept the stored copy.
    const after = hitsOf('/stale.png').slice(staleBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((h) => h.conditional)).toBe(true);
  });

  test('a big image shows as a thumbnail inline and in full in the lightbox, one fetch', async ({ launchApp }) => {
    const s = site!;
    const ch = randomChannel('thumb');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, ch, nick);
    await peer.join(ch);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    peer.privmsg(ch, `big http://127.0.0.1:${s.port}/big.png`);
    const row = messages(page).locator('.message-row').filter({ hasText: 'big' });
    const inline = row.locator('img.embed-img');
    await expect(inline).toHaveAttribute('src', /^\/_boson\/img\?k=web&.*&w=1280&h=560$/);
    // Scaled to the inline box (1280×560): 896×560, not 1600×1000.
    await expect.poll(() => inline.evaluate((i: HTMLImageElement) => `${i.naturalWidth}x${i.naturalHeight}`)).toBe('896x560');
    // At most 280 px high, in proportion (8:5).
    const box = (await inline.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(280.5);
    expect(Math.abs(box.width / box.height - 1.6)).toBeLessThan(0.02);
    await row.getByRole('button', { name: 'Open image' }).click();
    const full = page.locator('.embed-lightbox img');
    await expect.poll(() => full.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1600);
    expect(s.hits.filter((h) => h.path === '/big.png')).toHaveLength(1);
  });
});
