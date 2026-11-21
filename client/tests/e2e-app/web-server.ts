// Serves the e2e web build (out-e2e/web, `npm run build:e2e-web`) on the
// stack's fixed web origin (stack.json web.url), as the stack's web
// container serves it in production: the CSP header, /boson-config.js with
// the e2e stack's endpoints, /sso/callback, and the app for any other path.
// Started once per run by global-setup.ts. Every test gets its own browser
// profile, so one origin is enough.
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { APP_DIR, STACK } from './stack';

export const WEB_DIR = join(APP_DIR, 'web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// The production CSP (stack images/web) with the e2e stack's loopback hosts.
export const E2E_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  'img-src \'self\' data: blob: https: http://localhost:* http://127.0.0.1:*',
  "media-src 'self' https: blob: http://127.0.0.1:*",
  "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com",
  "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
].join('; ');

export function webConfigScript(): string {
  const cfg = {
    authUrl: STACK.auth.url,
    apiUrl: STACK.backend.url,
    directoryUrl: STACK.directory.url,
    gatewayUrl: STACK.web.gateway.url,
    e2e: true,
  };
  return `window.bosonWebConfig = ${JSON.stringify(cfg)};\n`;
}

// The YouTube wrapper's headers (infra/web/nginx.conf).
const WRAPPER_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

// Spotify's embed pages, for the API's link-preview fetcher: the e2e
// backend fetches https://open.spotify.com from this server
// (UNFURL_TEST_HOST_MAP in infra/e2e/docker-compose.yml). A test hands
// the pages over through bosonE2E.stubSpotify (platform/web/e2e.ts →
// POST /__e2e/spotify) and reads what was fetched back (GET).
const spotifyPages = new Map<string, string>();
const spotifyFetched: string[] = [];

// The backend runs in Docker and reaches this server as host.docker.internal:
// on Linux that's the docker bridge, so listen on every interface there
// (Docker Desktop forwards to the host's loopback).
export const E2E_BIND_HOST = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1';

export function startWebServer(dir = WEB_DIR, port = STACK.web.port): Promise<Server> {
  const index = readFileSync(join(dir, 'index.html'));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if ((req.headers.host ?? '').split(':')[0] === 'open.spotify.com') {
      const page = `https://open.spotify.com${url.pathname}`;
      spotifyFetched.push(page);
      const body = spotifyPages.get(page);
      res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body ?? 'not found');
      return;
    }
    if (url.pathname === '/__e2e/spotify') {
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (c: Buffer) => { raw += c.toString(); });
        req.on('end', () => {
          for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) spotifyPages.set(k, v);
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(spotifyFetched));
      return;
    }
    if (url.pathname === '/youtube-embed.html') {
      res.writeHead(200, {
        'Content-Type': TYPES['.html']!,
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': WRAPPER_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      res.end(readFileSync(join(dir, 'youtube-embed.html')));
      return;
    }
    const send = (status: number, type: string, body: Buffer | string, cache = 'no-store'): void => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': cache,
        'Content-Security-Policy': E2E_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(body);
    };
    if (url.pathname === '/boson-config.js') return send(200, TYPES['.js']!, webConfigScript());
    if (url.pathname === '/sso/callback') return send(200, TYPES['.html']!, readFileSync(join(dir, 'sso-callback.html')));
    const file = normalize(join(dir, decodeURIComponent(url.pathname)));
    if (file.startsWith(dir) && existsSync(file) && statSync(file).isFile()) {
      const immutable = url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return send(200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file), immutable);
    }
    if (url.pathname.startsWith('/assets/')) return send(404, 'text/plain', 'not found');
    return send(200, TYPES['.html']!, index);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, E2E_BIND_HOST, () => resolve(server));
  });
}
