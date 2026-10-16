// App shell and the desktop app's Go services: the title bar (on macOS the
// native traffic lights replace the drawn buttons), the About panel's
// update-state UI driven by real `updater:state` pushes (desktop/updater.go),
// the Inbox empty state, the engine pill, the engine dying under the app,
// the secure store's on-disk format (derived-key mode, corrupt files) and
// bridge validation, the API proxy's allowlist/redirect policy, and the
// Spotify metadata fetcher.
//
// Not covered here: what needs the native window (window controls,
// notification click → restore, webview permissions) is checked by hand on
// the native build; the e2e app is a server-mode build driven in Chromium.
// Not covered because the app doesn't have them: a theme toggle in the title
// bar (theme lives in User settings → Appearance and is fixed to dark) and
// global keyboard shortcuts (only Escape-to-dismiss on menus/dialogs, which
// the bouncer specs exercise).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  test, expect, uid, IRC_HOST, IRC_PORT, field,
  continueAsGuest, addServerManually, serverCard, joinChannel, messageList,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import { e2eHook } from './desktop-app';
import { crashEngine, engineId } from './helpers/engine';

async function openUserSettings(page: Page, tab: RegExp): Promise<Locator> {
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: tab }).click();
  return dialog;
}

async function connectDirect(page: Page, name: string): Promise<void> {
  await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name, tls: false });
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
}

// Secure-store tag on disk: the e2e build runs the store in its derived-key
// mode (BOSON_SECURE_STORE=derived), whose values are "fb1:" ciphertext,
// never plain text.
const STORE_TAG = /^fb1:/;

test.describe('app shell', () => {
  // The shell reports the OS (bosonPlatform), and the title bar follows it.
  async function titleBar(page: Page): Promise<Locator> {
    await continueAsGuest(page, `tb${uid()}`);
    const bar = page.locator('.title-bar');
    await expect(bar.locator('.title-bar-title')).toHaveText('Boson');
    await expect(bar.getByRole('button', { name: 'Inbox' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'User settings' })).toContainText('guest');

    if (process.platform === 'darwin') {
      // macOS keeps the native traffic lights (hiddenInset): no drawn controls.
      await expect(bar).toHaveClass(/title-bar-darwin/);
      for (const name of ['Minimize', 'Maximize', 'Restore', 'Close']) {
        await expect(bar.getByRole('button', { name, exact: true })).toHaveCount(0);
      }
    } else {
      await expect(bar.getByRole('button', { name: 'Minimize' })).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Maximize' })).toBeVisible();
    }
    return bar;
  }

  test('the title bar follows the platform', async ({ launchApp }) => {
    const { page } = await launchApp();
    await titleBar(page);
  });

  test('About: update states pushed from main drive the version row', async ({ launchApp }) => {
    const { app, page, openedExternally } = await launchApp();
    await continueAsGuest(page, `up${uid()}`);
    const dialog = await openUserSettings(page, /^About/);
    const row = dialog.locator('.user-settings-version-row');
    await expect(row.getByRole('button', { name: 'Check for updates' })).toBeVisible();

    // The state as the Go updater pushes it (desktop/updater.go).
    const push = (state: Record<string, unknown>): Promise<void> => e2eHook(app, 'pushUpdaterState', state);

    await push({ kind: 'checking' });
    await expect(row).toContainText('Checking…');
    await expect(row.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
    await push({ kind: 'available', version: '99.0.0' });
    await expect(row).toContainText('v99.0.0 available — downloading.');
    await push({ kind: 'downloading', version: '99.0.0', percent: 42, bytesPerSecond: 1000 });
    await expect(row).toContainText('Downloading v99.0.0 · 42%');
    await push({ kind: 'ready', version: '99.0.0' });
    // "Restart to apply": the app can't install in place yet
    // (docs/wails-migration.md, Phase 5), so it opens the release page and
    // stays up.
    await row.getByRole('button', { name: 'Restart to apply v99.0.0' }).click();
    await expect(row.getByRole('button', { name: 'Restart to apply v99.0.0' })).toBeVisible();
    await expect.poll(() => openedExternally()).toContain('https://github.com/boson-chat/boson/releases/latest');

    // Error verdicts are summarised for humans; the raw text never shows.
    await push({ kind: 'error', message: 'HttpError: 404 \n"method: GET url: https://x/latest-mac.yml"' });
    await expect(row).toContainText("Update info isn't published yet. Try again in a few minutes.");
    await push({ kind: 'error', message: 'getaddrinfo ENOTFOUND github.com' });
    await expect(row).toContainText("Couldn't reach update server — check your connection.");
    await push({ kind: 'error', message: 'net::ERR_TIMED_OUT' });
    await expect(row).toContainText('Network timeout while checking for updates.');
    await push({ kind: 'error', message: 'Something specific broke' });
    await expect(row).toContainText('Something specific broke');

    // A manual check from the error state: unpackaged → "Up to date." — and
    // the updater's own state (what a re-opened panel starts from) agrees.
    await row.getByRole('button', { name: 'Check for updates' }).click();
    await expect(row).toContainText('Up to date.');
    expect(await page.evaluate(() => (window as unknown as { bosonUpdater: { getState: () => Promise<{ kind: string }> } })
      .bosonUpdater.getState())).toMatchObject({ kind: 'up-to-date' });
  });

  test('Inbox empty states and the idle engine pill', async ({ launchApp }) => {
    const { page } = await launchApp();
    await continueAsGuest(page, `ib${uid()}`);
    // Directory top bar: no servers yet → the engine pill is idle and inert.
    const pill = page.locator('.engine-pill');
    await expect(pill).toHaveText('engine · idle');
    await expect(pill).toBeDisabled();
    await expect(pill).toHaveAttribute('title', 'Engine: idle');

    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    const inbox = page.getByRole('dialog', { name: 'Inbox' });
    await expect(inbox.getByText('No messages yet')).toBeVisible();
    await inbox.getByRole('tab', { name: /Mentions/ }).click();
    await expect(inbox.getByText('No mentions yet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(inbox).toBeHidden();
  });

  test('engine killed: the app shows the lost connection', async ({ launchApp }) => {
    const nick = `ek${uid()}`;
    const serverName = `Crash Ergo ${uid(4)}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      const { app, page } = await launchApp();
      await continueAsGuest(page, nick);
      await connectDirect(page, serverName);
      const channel = `#e2e-ek-${uid(8)}`;
      await peer.join(channel);
      await joinChannel(page, channel);
      await peer.waitForJoin(channel, nick);

      const quitMark = peer.mark();
      await crashEngine(app);

      // The IRC connection dies with it…
      await peer.waitFor(
        (l) => l.command === 'QUIT' && l.prefix.split('!')[0]!.toLowerCase() === nick.toLowerCase(),
        30_000, `${nick} QUIT after the engine died`, quitMark,
      );
      // …and the UI stops claiming to be connected.
      await expect(page.locator('.sidebar-status-dot')).not.toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
      await expect(page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: new RegExp(`^${serverName} \\((disconnected|connecting)\\)`) }))
        .toBeVisible();
    } finally {
      await peer.quit();
    }
  });

  // The renderer reconnects to a new in-process engine session: the app is
  // back on its own.
  test('engine killed: a new one starts and the session recovers', async ({ launchApp }) => {
    const { app, page } = await launchApp();
    await continueAsGuest(page, `er${uid()}`);
    await connectDirect(page, `Recover Ergo ${uid(4)}`);
    const killed = await crashEngine(app);
    await expect(page.locator('.sidebar-status-dot')).not.toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
    expect(await engineId(app)).not.toBe(killed);
  });
});

// ---- secure store (desktop/securestore.go) ---------------------------------

// The derived-key fallback format ("fb1:"), as secure-store.ts writes it on a
// host without a usable OS keychain (headless Linux, WSL).
function fallbackEncrypt(plaintext: string): string {
  const key = createHash('sha256').update([userInfo().username, hostname(), 'boson-secure-store-fallback-v1'].join('::')).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `fb1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

test.describe('secure store', () => {
  test('values written by the derived-key fallback still load; unreadable ones count as missing', async ({ launchApp, profile }) => {
    const host = `fallback-${uid()}.example.test`;
    writeFileSync(join(profile.userData, 'identity-store.json'), JSON.stringify({
      'boson.bouncer.v1': fallbackEncrypt(JSON.stringify({
        enabled: true, host, port: 6501, tls: false, tlsInsecure: false, username: 'fbuser', password: 'fbpass',
      })),
      // Untagged legacy value that isn't valid keychain ciphertext, and a
      // non-string entry: both ignored rather than breaking the store.
      'boson.services-creds.v1': 'bm90IGtleWNoYWluIGNpcGhlcnRleHQ=',
      'not-a-string': 42,
    }), { mode: 0o600 });

    const { page } = await launchApp();
    await continueAsGuest(page, `ss${uid()}`);
    const dialog = await openUserSettings(page, /^Bouncer/);
    await expect(field(dialog, 'Host')).toHaveValue(host);
    await expect(field(dialog, 'Username')).toHaveValue('fbuser');
    await expect(field(dialog, 'Password')).toHaveValue('fbpass');

    // Re-saving rewrites it in the preferred format for this platform.
    const before = (JSON.parse(readFileSync(join(profile.userData, 'identity-store.json'), 'utf8')) as Record<string, unknown>)['boson.bouncer.v1'];
    await field(dialog, 'Port').fill('6502');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => (JSON.parse(readFileSync(join(profile.userData, 'identity-store.json'), 'utf8')) as Record<string, unknown>)['boson.bouncer.v1'])
      .not.toBe(before);
    expect((JSON.parse(readFileSync(join(profile.userData, 'identity-store.json'), 'utf8')) as Record<string, string>)['boson.bouncer.v1'])
      .toMatch(STORE_TAG);
  });

  test('a corrupt store file is replaced on the next write; the bridge rejects malformed calls', async ({ launchApp, profile }) => {
    writeFileSync(join(profile.userData, 'identity-store.json'), '{ this is not json', { mode: 0o600 });
    const { page } = await launchApp();
    await continueAsGuest(page, `sc${uid()}`);

    const sec = (fn: string, ...args: unknown[]): Promise<unknown> => page.evaluate(
      ([f, a]) => (window as unknown as { bosonSecure: Record<string, (...x: unknown[]) => Promise<unknown>> }).bosonSecure[f as string]!(...(a as unknown[])),
      [fn, args] as const,
    );
    expect(await sec('isAvailable')).toBe(true);
    await expect(sec('get', '')).rejects.toThrow(/non-empty string key/);
    await expect(sec('set', '', 'v')).rejects.toThrow(/non-empty string key/);
    await expect(sec('set', 'k', 5)).rejects.toThrow(/requires a string value/);
    await expect(sec('remove', '')).rejects.toThrow(/non-empty string key/);
    expect(await sec('get', 'e2e.missing')).toBeNull();

    await sec('set', 'e2e.probe', 'secret-value');
    expect(await sec('get', 'e2e.probe')).toBe('secret-value');
    const onDisk = JSON.parse(readFileSync(join(profile.userData, 'identity-store.json'), 'utf8')) as Record<string, string>;
    expect(onDisk['e2e.probe']).toMatch(STORE_TAG);
    expect(JSON.stringify(onDisk)).not.toContain('secret-value');
    await sec('remove', 'e2e.probe');
    await sec('remove', 'e2e.never-set'); // no-op
    expect(await sec('get', 'e2e.probe')).toBeNull();
  });
});

// ---- API proxy (desktop/apiproxy.go) ---------------------------------------

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }

function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

test.describe('API proxy', () => {
  test('only reaches allowlisted origins, re-checks every redirect hop, strips credentials across origins', async ({ launchApp }) => {
    const seenB: Seen[] = [];
    const b = await listen((req, res, body) => {
      seenB.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`B saw ${req.method} ${req.url}`);
    });
    const a = await listen((req, res, body) => {
      const u = req.url!;
      if (u === '/ok') return void res.writeHead(201).end(`echo ${req.method} ${body} ${req.headers['x-e2e'] ?? ''}`);
      if (u === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
      if (u === '/metadata') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
      if (u === '/to-file') return void res.writeHead(302, { location: 'file:///etc/passwd' }).end();
      if (u === '/no-location') return void res.writeHead(302).end();
      if (u === '/cross') return void res.writeHead(307, { location: `http://localhost:${b.port}/landing` }).end();
      if (u === '/see-other') return void res.writeHead(303, { location: `http://localhost:${b.port}/after-post` }).end();
      res.writeHead(404).end();
    });
    try {
      const { page } = await launchApp();
      await page.waitForLoadState('domcontentloaded');
      const call = (req: Record<string, unknown>): Promise<{ status: number; ok: boolean; statusText: string; text: string }> =>
        page.evaluate((r) => (window as unknown as { bosonApi: { fetch: (x: unknown) => Promise<{ status: number; ok: boolean; statusText: string; text: string }> } })
          .bosonApi.fetch(r), req);
      const A = `http://127.0.0.1:${a.port}`;

      // Loopback is allowed in unpackaged builds (dev backends).
      expect(await call({ method: 'POST', url: `${A}/ok`, body: 'hi', headers: { 'x-e2e': 'yes' } }))
        .toMatchObject({ status: 201, ok: true, text: 'echo POST hi yes' });

      // Not on the allowlist / not http(s) / malformed: refused without a request.
      expect(await call({ method: 'GET', url: 'https://example.com/' })).toMatchObject({ status: 0, statusText: 'Blocked host' });
      expect(await call({ method: 'GET', url: 'https://api.boson.chat.evil.example/' })).toMatchObject({ statusText: 'Blocked host' });
      expect(await call({ method: 'GET', url: 'file:///etc/passwd' })).toMatchObject({ statusText: 'Bad scheme' });
      expect(await call({ method: 'GET', url: 'not a url' })).toMatchObject({ statusText: 'Bad URL' });
      expect(await call({ url: `${A}/ok` })).toMatchObject({ statusText: 'Bad request' });

      // Redirects are followed by hand so each hop is checked.
      expect(await call({ method: 'GET', url: `${A}/metadata` })).toMatchObject({ status: 0, statusText: 'Blocked redirect host' });
      expect(await call({ method: 'GET', url: `${A}/to-file` })).toMatchObject({ statusText: 'Bad redirect scheme' });
      expect(await call({ method: 'GET', url: `${A}/no-location` })).toMatchObject({ statusText: 'Redirect without location' });
      expect(await call({ method: 'GET', url: `${A}/loop` })).toMatchObject({ statusText: 'Too many redirects' });

      // A cross-origin hop keeps the request but drops Authorization/Cookie.
      expect(await call({
        method: 'GET', url: `${A}/cross`, headers: { Authorization: 'Bearer secret', Cookie: 'sid=1', 'X-Keep': 'kept' },
      })).toMatchObject({ status: 200, text: 'B saw GET /landing' });
      const landing = seenB.find((s) => s.url === '/landing')!;
      expect(landing.headers['authorization']).toBeUndefined();
      expect(landing.headers['cookie']).toBeUndefined();
      expect(landing.headers['x-keep']).toBe('kept');

      // 303 after a POST turns into a bodyless GET.
      expect(await call({ method: 'POST', url: `${A}/see-other`, body: 'payload' }))
        .toMatchObject({ status: 200, text: 'B saw GET /after-post' });
      expect(seenB.find((s) => s.url === '/after-post')).toMatchObject({ method: 'GET', body: '' });
    } finally {
      a.server.close();
      b.server.close();
    }
  });
});

// ---- Spotify (desktop/spotify.go) ------------------------------------------

function spotifyEmbedPage(entity: Record<string, unknown>): string {
  const data = { props: { pageProps: { state: { data: { entity } } } } };
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

test.describe('Spotify', () => {
  // The app fetches https://open.spotify.com/embed/<type>/<id> — a fixed
  // host (that's its SSRF guard), so the e2e build's StubSpotify hook serves
  // those pages in place of the network instead of redirecting it anywhere.
  test('a Spotify link renders a native card from the embed page; other hosts are never fetched', async ({ launchApp }) => {
    const playlistId = `PL${uid(10)}`;
    const pages: Record<string, string> = {
      [`https://open.spotify.com/embed/playlist/${playlistId}`]: spotifyEmbedPage({
        type: 'playlist', name: 'E2E Mix', subtitle: 'by boson',
        trackList: [
          { title: 'First Song', subtitle: 'Artist One', duration: 185_000, audioPreview: { url: 'https://p.scdn.co/mp3-preview/1' } },
          { title: 'Second Song', subtitle: 'Artist Two', duration: 61_000 },
          { title: '', subtitle: 'dropped: no title' },
        ],
      }),
      'https://open.spotify.com/embed/track/T1': spotifyEmbedPage({
        type: 'track', title: 'Solo', artists: [{ name: 'A' }, { name: 'B' }], duration: 1000,
        audioPreview: { url: 'https://p.scdn.co/mp3-preview/solo' },
        visualIdentity: { image: [{ url: 'https://i.scdn.co/small', maxWidth: 64 }, { url: 'https://i.scdn.co/big', maxWidth: 640 }] },
      }),
      'https://open.spotify.com/embed/album/NODATA': '<html>no next data</html>',
    };
    const nick = `sp${uid()}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      const { app, page } = await launchApp();
      await e2eHook(app, 'stubSpotify', pages);
      const fetched = (): Promise<string[]> => e2eHook<string[]>(app, 'spotifyFetched');
      const info = (url: string): Promise<unknown> =>
        page.evaluate((u) => (window as unknown as { bosonSpotify: { fetch: (x: string) => Promise<unknown> } }).bosonSpotify.fetch(u), url);

      // The bridge: URL forms normalised to the embed page; parsed fields.
      expect(await info('https://open.spotify.com/intl-de/track/T1?si=abc')).toEqual({
        url: 'https://open.spotify.com/intl-de/track/T1?si=abc', type: 'track', title: 'Solo', subtitle: 'A, B',
        cover: 'https://i.scdn.co/big', durationMs: 1000, previewUrl: 'https://p.scdn.co/mp3-preview/solo',
      });
      // Cached: a second ask doesn't refetch.
      await info('https://open.spotify.com/track/T1');
      expect((await fetched()).filter((u) => u.endsWith('/track/T1'))).toHaveLength(1);
      // No __NEXT_DATA__ / unknown entity / 404 → null.
      expect(await info('https://open.spotify.com/album/NODATA')).toBeNull();
      expect(await info('https://open.spotify.com/show/MISSING')).toBeNull();
      // Anything but open.spotify.com/<known type>/<id> is refused up front.
      for (const u of ['https://evil.example/track/T1', 'https://open.spotify.com/user/someone', 'not a url', 'http://127.0.0.1:9/track/x']) {
        expect(await info(u)).toBeNull();
      }
      expect((await fetched()).every((u) => u.startsWith('https://open.spotify.com/embed/'))).toBe(true);

      // End to end: a peer posts a playlist link in a channel.
      await continueAsGuest(page, nick);
      await connectDirect(page, `Spotify Ergo ${uid(4)}`);
      const channel = `#e2e-sp-${uid(8)}`;
      await peer.join(channel);
      await joinChannel(page, channel);
      await peer.waitForJoin(channel, nick);
      peer.privmsg(channel, `listen https://open.spotify.com/playlist/${playlistId}?si=x`);
      const card = messageList(page).locator('.embed-spotify');
      await expect(card.locator('.embed-spotify-title')).toHaveText('E2E Mix', { timeout: 20_000 });
      await expect(card).toContainText('Spotify · Playlist');
      await expect(card.locator('.embed-spotify-sub')).toHaveText('by boson · 2 songs');
      const tracks = card.locator('.embed-spotify-track');
      await expect(tracks).toHaveCount(2);
      await expect(tracks.nth(0)).toContainText('First Song');
      await expect(tracks.nth(0)).toContainText('3:05');
      await expect(tracks.nth(0).getByRole('button', { name: 'Play First Song' })).toBeEnabled();
      await expect(tracks.nth(1).getByRole('button', { name: 'Second Song' })).toBeDisabled(); // no preview
      await expect(card.getByRole('link', { name: 'Open in Spotify ↗' })).toHaveAttribute('href', `https://open.spotify.com/playlist/${playlistId}?si=x`);
    } finally {
      await peer.quit();
    }
  });
});
