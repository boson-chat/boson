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
  'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
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

export function startWebServer(dir = WEB_DIR, port = STACK.web.port): Promise<Server> {
  const index = readFileSync(join(dir, 'index.html'));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
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
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
