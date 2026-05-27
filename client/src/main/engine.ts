// Engine supervisor — spawns the bundled Go IRC bridge as a child process
// when the app starts in packaged mode, hands the renderer its loopback
// URL + auth token via IPC, and tears it down cleanly on quit.
//
// Loopback-only design: the engine binds 127.0.0.1:<random-free-port>, so
// nothing else on the host (or the network) can reach it. A 24-byte
// random token gates the WebSocket handshake on top of that.
//
// In `npm run dev` (app.isPackaged === false) the bundled binary isn't
// available — the dev workflow is `make engine-serve` in a separate
// terminal and the renderer reads VITE_ENGINE_URL/TOKEN from .env. Here
// we return null in that case and let the renderer's existing fallback
// handle it.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';

export interface EngineDiscovery {
  url: string;
  token: string;
}

class EngineSupervisor {
  private child: ChildProcess | null = null;
  private discovery: EngineDiscovery | null = null;

  async start(): Promise<EngineDiscovery | null> {
    if (this.discovery) return this.discovery;

    const binary = this.locateBinary();
    if (!binary) {
      console.warn(
        '[engine] no sidecar binary found for ' +
          `${process.platform}/${process.arch} — falling back to ` +
          'VITE_ENGINE_URL/TOKEN if set (dev workflow).',
      );
      return null;
    }

    const port = await this.pickFreePort();
    const token = randomBytes(24).toString('base64url');
    const addr = `127.0.0.1:${port}`;

    console.log(`[engine] spawning ${binary} serve --addr ${addr}`);
    // --token-from-env tells the engine to use BOSON_ENGINE_TOKEN from the
    // environment instead of generating its own random token. Without it
    // the engine ignores the env var and the renderer's token won't
    // match → HTTP Auth failed on every WebSocket connection attempt.
    this.child = spawn(binary, ['serve', '--addr', addr, '--token-from-env'], {
      env: { ...process.env, BOSON_ENGINE_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Forward engine output to the main process console so issues are
    // visible alongside everything else (Electron's stderr ends up in
    // the system log on macOS, the launching terminal on Linux, and
    // the user-data dir on Windows).
    this.child.stdout?.on('data', (b: Buffer) => process.stdout.write(`[engine] ${b}`));
    this.child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[engine] ${b}`));
    this.child.on('exit', (code, signal) => {
      console.log(`[engine] exited code=${code} signal=${signal}`);
      this.child = null;
    });

    this.discovery = { url: `ws://${addr}/ws`, token };
    return this.discovery;
  }

  stop(): void {
    if (!this.child) return;
    console.log('[engine] stopping');
    this.child.kill();
    this.child = null;
    this.discovery = null;
  }

  current(): EngineDiscovery | null {
    return this.discovery;
  }

  // Resolves to a 'engine-<os>-<arch>(.exe)' binary inside the app's
  // resources directory. The release-client GitHub workflow drops these
  // there per-platform before electron-builder packages the app (see
  // client/electron-builder.yml `extraResources`).
  private locateBinary(): string | null {
    const base = app.isPackaged
      ? join(process.resourcesPath, 'engine')
      : join(app.getAppPath(), 'resources', 'engine');
    const os = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const ext = process.platform === 'win32' ? '.exe' : '';
    const candidate = join(base, `engine-${os}-${arch}${ext}`);
    return existsSync(candidate) ? candidate : null;
  }

  // Asks the kernel for a free port by binding to :0 and immediately
  // closing. There's a small TOCTOU window between resolving the port
  // and the engine actually claiming it — acceptable for loopback
  // single-user use; would matter on a busy multi-tenant box.
  private pickFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        srv.close(() => {
          if (addr && typeof addr === 'object') resolve(addr.port);
          else reject(new Error('failed to resolve a free loopback port'));
        });
      });
    });
  }
}

export const engine = new EngineSupervisor();
