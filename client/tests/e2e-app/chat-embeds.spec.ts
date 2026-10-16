// Rich embeds for links in messages, served by a local HTTP server:
//   - website previews come from the main process's unfurler (OpenGraph),
//     which refuses loopback / private hosts (SSRF guard). The page is served
//     under a NAME (unfurl.e2e.test) that BOSON_E2E_HOST_MAP resolves to
//     127.0.0.1 inside the app's main process only (electron-sandbox-hook) —
//     the guard itself is untouched, and a loopback URL is asserted refused;
//   - images / files load straight from 127.0.0.1 in the renderer (its CSP
//     allows loopback images).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, randomChannel } from './fixtures';
import { connectGuest, connectPeer, messages, memberRow, joinViaUi } from './helpers/chat';
import type { IrcPeer } from './irc-peer';
import { request } from 'node:http';
import { WAILS_SHELL } from './wails-shell';

// GET origin+path on 127.0.0.1 with the origin's Host header (Node can't
// resolve *.localhost names); resolves to the status code.
function hostStatus(origin: string, path: string): Promise<number> {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: u.port, path, headers: { Host: u.host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject).end();
  });
}

const HOST = 'unfurl.e2e.test';
// 2x2 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
  'base64',
);

interface TestSite {
  port: number;
  hits: Array<{ path: string; host: string; ua: string }>;
  close: () => Promise<void>;
}

async function startSite(): Promise<TestSite> {
  const hits: TestSite['hits'] = [];
  let port = 0;
  const server: Server = createServer((req: IncomingMessage, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits.push({ path, host: req.headers.host ?? '', ua: String(req.headers['user-agent'] ?? '') });
    if (path === '/article.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="Boson &amp; the e2e article">
        <meta property="og:description" content="A page served by the test, unfurled by the app.">
        <meta property="og:site_name" content="E2E Gazette">
        <meta property="og:image" content="http://127.0.0.1:${port}/og.png">
      </head><body>hello</body></html>`);
      return;
    }
    if (path === '/plain.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Only a title</title></head><body></body></html>');
      return;
    }
    if (path.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      res.end(PNG);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test.describe('embeds', () => {
  let peers: IrcPeer[] = [];
  let site: TestSite | null = null;
  test.beforeEach(async () => { site = await startSite(); });
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
    await site?.close();
  });

  test('auto-loaded website card, image lightbox, file download guard, SSRF refusal', async ({ launchApp }) => {
    const s = site!;
    const channel = randomChannel('emb');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick, openedExternally } = await connectGuest(launchApp, {
      env: { BOSON_E2E_HOST_MAP: `${HOST}=127.0.0.1` },
    });
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    const row = (text: string) => messages(page).locator('.message-row').filter({ hasText: text });

    // Website: unfurled by main (one request, with a browser UA) → card.
    const article = `http://${HOST}:${s.port}/article.html`;
    peer.privmsg(channel, `web1 have a look ${article}`);
    const card = row('web1').locator('.embed-card');
    await expect(card.locator('.embed-card-site')).toHaveText('E2E Gazette');
    await expect(card.locator('.embed-card-title')).toHaveText('Boson & the e2e article');
    await expect(card.locator('.embed-card-desc')).toHaveText('A page served by the test, unfurled by the app.');
    const ogImg = card.locator('img.embed-card-img');
    await expect(ogImg).toHaveAttribute('src', `http://127.0.0.1:${s.port}/og.png`);
    await expect.poll(() => ogImg.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(2);
    const pageHit = s.hits.find((h) => h.path === '/article.html');
    expect(pageHit?.host).toBe(`${HOST}:${s.port}`);
    expect(pageHit?.ua).toMatch(/Mozilla\/5\.0/);
    // The card's title opens the page in the OS browser.
    await card.locator('.embed-card-title').click();
    await expect.poll(openedExternally).toContain(article);

    // A page with only a <title> still gets a card (falls back to the domain).
    peer.privmsg(channel, `web2 http://${HOST}:${s.port}/plain.html`);
    await expect(row('web2').locator('.embed-card-title')).toHaveText('Only a title');
    await expect(row('web2').locator('.embed-card-site')).toHaveText(HOST);

    // A 404 → no card, a link card offering the browser.
    peer.privmsg(channel, `web3 http://${HOST}:${s.port}/missing`);
    await expect(row('web3').locator('.embed-linkcard-hint')).toHaveText('Preview unavailable — open in browser');

    // SSRF guard: a loopback URL is never fetched by the unfurler.
    const before = s.hits.length;
    peer.privmsg(channel, `web4 http://127.0.0.1:${s.port}/article.html?ssrf=1`);
    await expect(row('web4').locator('.embed-linkcard-hint')).toHaveText('Preview unavailable — open in browser');
    peer.privmsg(channel, `web5 http://localhost:${s.port}/article.html?ssrf=2`);
    await expect(row('web5').locator('.embed-linkcard-hint')).toHaveText('Preview unavailable — open in browser');
    expect(s.hits.slice(before).filter((h) => h.path === '/article.html')).toEqual([]);

    // Image: auto-loaded inline; click → lightbox; Escape closes.
    peer.privmsg(channel, `img1 http://127.0.0.1:${s.port}/cat.png`);
    const img = row('img1').locator('img.embed-img');
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(2);
    await row('img1').getByRole('button', { name: 'Open image' }).click();
    const lightbox = page.locator('.embed-lightbox');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.locator('img')).toHaveAttribute('src', `http://127.0.0.1:${s.port}/cat.png`);
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    await row('img1').getByRole('button', { name: 'Open image' }).click();
    await lightbox.getByRole('button', { name: 'Close' }).click();
    await expect(lightbox).toHaveCount(0);
    // Dismissing an embed removes it (the link text stays).
    await row('img1').getByRole('button', { name: 'Dismiss embed' }).click();
    await expect(row('img1').locator('.embed')).toHaveCount(0);
    await expect(row('img1').locator('a.md-link')).toBeVisible();

    // Video: an inline player (metadata only until played).
    peer.privmsg(channel, `vid1 http://127.0.0.1:${s.port}/clip.mp4`);
    const video = row('vid1').locator('video.embed-video-el');
    await expect(video).toHaveAttribute('src', `http://127.0.0.1:${s.port}/clip.mp4`);
    await expect(video).toHaveAttribute('controls', '');

    // Files: a guarded download chip → confirm → OS browser. Executables get
    // a stronger warning.
    const zip = `http://127.0.0.1:${s.port}/notes.zip`;
    peer.privmsg(channel, `file1 ${zip}`);
    await row('file1').getByRole('button', { name: /\.zip file · 127\.0\.0\.1 — download/ }).click();
    const dl = page.getByRole('dialog', { name: 'Download a file?' });
    await expect(dl.locator('.embed-file-url')).toHaveText(zip);
    await dl.getByRole('button', { name: 'Open in browser' }).click();
    await expect(dl).toBeHidden();
    await expect.poll(openedExternally).toContain(zip);

    const exe = `http://127.0.0.1:${s.port}/setup.exe`;
    peer.privmsg(channel, `file2 ${exe}`);
    await row('file2').getByRole('button', { name: /\.exe file/ }).click();
    const warn = page.getByRole('dialog', { name: 'Download an executable?' });
    await expect(warn).toContainText('This is an executable / installer.');
    await warn.getByRole('button', { name: 'Cancel' }).click();
    await expect(warn).toBeHidden();
    expect(await openedExternally()).not.toContain(exe);
  });

  // YouTube refuses some videos (label / VEVO music videos) when the page
  // around its player is a local address, and the app runs on
  // http://127.0.0.1. So the player is framed by the app's own wrapper page
  // under youtube-embed.invalid (mapped to 127.0.0.1 in main). YouTube is
  // stubbed here: the stub reports which page embeds it.
  test('YouTube plays inside the wrapper, whose address is a hostname, not 127.0.0.1', async ({ launchApp }) => {
    const channel = randomChannel('emy');
    const peer = await connectPeer();
    peers.push(peer);
    const { app, page, nick } = await connectGuest(launchApp);
    await app.context().route('https://www.youtube-nocookie.com/embed/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body><p id="who"></p><script>
        document.getElementById('who').textContent =
          'embedded by ' + location.ancestorOrigins[0] + ' via ' + document.referrer;
      </script></body>`,
    }));
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    peer.privmsg(channel, 'yt1 https://www.youtube.com/watch?v=KtypSRcwIhA');
    const row = messages(page).locator('.message-row').filter({ hasText: 'yt1' });
    await row.getByRole('button', { name: 'Play video' }).click();

    // Electron: the app's own server under youtube-embed.invalid. Wails: the
    // shell's loopback wrapper server under youtube-embed.localhost.
    const wrapperOrigin = WAILS_SHELL
      ? await page.evaluate(() => (window as unknown as { bosonYouTube: { wrapperOrigin: string } }).bosonYouTube.wrapperOrigin)
      : `http://youtube-embed.invalid:${new URL(page.url()).port}`;
    const iframe = row.locator('iframe.embed-yt-iframe');
    await expect(iframe).toHaveAttribute('src', `${wrapperOrigin}/youtube-embed.html?v=KtypSRcwIhA`);
    const player = page.frameLocator('iframe.embed-yt-iframe').frameLocator('iframe');
    await expect(player.locator('#who')).toHaveText(`embedded by ${wrapperOrigin} via ${wrapperOrigin}/`);
    // The wrapper said it loaded, so the app keeps it (no fallback to a direct embed).
    await page.waitForTimeout(7_000);
    await expect(iframe).toHaveAttribute('src', `${wrapperOrigin}/youtube-embed.html?v=KtypSRcwIhA`);

    // Under that hostname the app's own server hands out the wrapper only,
    // never the app. (net.fetch goes through Chromium, which applies the
    // host mapping.)
    const status = (path: string): Promise<number> => WAILS_SHELL
      ? hostStatus(wrapperOrigin, path)
      : app.evaluate(async ({ net }, u) => (await net.fetch(u)).status, `${wrapperOrigin}${path}`);
    expect(await status('/youtube-embed.html')).toBe(200);
    expect(await status('/youtube-embed.js')).toBe(200);
    expect(await status('/')).toBe(404);
    expect(await status('/index.html')).toBe(404);
  });

  // A video YouTube won't play here (embedding disabled by its owner, or
  // "Error 153" for the embedding page): the wrapper passes on the player's
  // error, and the app swaps the broken player for the card, which opens the
  // video on YouTube. The stub player answers the iframe API's handshake
  // with an error, as YouTube's does.
  test('a video YouTube refuses to play here becomes a card that opens it on YouTube', async ({ launchApp }) => {
    const channel = randomChannel('emye');
    const peer = await connectPeer();
    peers.push(peer);
    const { app, page, nick, openedExternally } = await connectGuest(launchApp);
    await app.context().route('https://www.youtube-nocookie.com/embed/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body><script>
        addEventListener('message', (e) => {
          if (typeof e.data === 'string' && JSON.parse(e.data).event === 'listening') {
            parent.postMessage(JSON.stringify({ event: 'onError', info: 153 }), '*');
          }
        });
      </script></body>`,
    }));
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    const url = 'https://youtu.be/VLu6poVQq-E';
    peer.privmsg(channel, `yte ${url}`);
    const row = messages(page).locator('.message-row').filter({ hasText: 'yte' });
    await row.getByRole('button', { name: 'Play video' }).click();
    // Well inside the wrapper's 6 s timeout, which under Wails also ends in
    // the card: this is the error message's doing.
    await expect(row.locator('iframe.embed-yt-iframe')).toHaveCount(0, { timeout: 4_000 });
    await row.getByRole('button', { name: 'Watch on YouTube' }).click();
    await expect.poll(openedExternally).toContain(url);
  });

  // The wrapper never reports in (it didn't load). Electron falls back to
  // embedding YouTube directly, which plays most videos there. Under Wails a
  // direct embed can only fail (the page is wails://), so it's the card.
  test('a wrapper that never loads: a direct embed in Electron, the card under Wails', async ({ launchApp }) => {
    const channel = randomChannel('emyw');
    const peer = await connectPeer();
    peers.push(peer);
    const { app, page, nick } = await connectGuest(launchApp);
    await app.context().route(/\/youtube-embed\.html\?/, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await app.context().route('https://www.youtube-nocookie.com/embed/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>player</p>' }));
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    peer.privmsg(channel, 'ytw https://www.youtube.com/watch?v=KtypSRcwIhA');
    const row = messages(page).locator('.message-row').filter({ hasText: 'ytw' });
    await row.getByRole('button', { name: 'Play video' }).click();
    const iframe = row.locator('iframe.embed-yt-iframe');
    await expect(iframe).toHaveAttribute('src', /\/youtube-embed\.html\?v=KtypSRcwIhA$/);
    if (WAILS_SHELL) {
      await expect(iframe).toHaveCount(0, { timeout: 15_000 });
      await expect(row.getByRole('button', { name: 'Watch on YouTube' })).toBeVisible();
    } else {
      await expect(iframe).toHaveAttribute('src', /^https:\/\/www\.youtube-nocookie\.com\/embed\/KtypSRcwIhA\?/, { timeout: 15_000 });
    }
  });

  test('click-to-load mode keeps embeds inert until clicked', async ({ launchApp }) => {
    const s = site!;
    const channel = randomChannel('emc');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp, { env: { BOSON_E2E_HOST_MAP: `${HOST}=127.0.0.1` } });
    // The privacy setting (User settings → Embeds) persists in localStorage;
    // it's read when the first embed renders.
    await page.evaluate(() => localStorage.setItem('boson:embeds:v1', JSON.stringify({ loadMode: 'click' })));
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    const row = (text: string) => messages(page).locator('.message-row').filter({ hasText: text });

    const article = `http://${HOST}:${s.port}/article.html`;
    peer.privmsg(channel, `lazy1 ${article}`);
    peer.privmsg(channel, `lazy2 http://127.0.0.1:${s.port}/dog.png`);
    peer.privmsg(channel, `lazy3 http://127.0.0.1:${s.port}/movie.webm`);
    const linkcard = row('lazy1').locator('.embed-linkcard');
    await expect(linkcard).toContainText('Click to load preview');
    const chip = row('lazy2').getByRole('button', { name: /Image · 127\.0\.0\.1 — click to load/ });
    await expect(chip).toBeVisible();
    const videoChip = row('lazy3').getByRole('button', { name: /Video · 127\.0\.0\.1 — click to play/ });
    await expect(videoChip).toBeVisible();
    // Nothing was fetched yet.
    expect(s.hits.map((h) => h.path)).toEqual([]);

    await linkcard.click();
    await expect(row('lazy1').locator('.embed-card-title')).toHaveText('Boson & the e2e article');
    await videoChip.click();
    await expect(row('lazy3').locator('video.embed-video-el')).toBeVisible();
    await chip.click();
    await expect.poll(() => row('lazy2').locator('img.embed-img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(2);
    expect(s.hits.map((h) => h.path)).toEqual(expect.arrayContaining(['/article.html', '/dog.png']));
  });
});
