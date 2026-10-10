// ZNC users for bouncer specs. infra/e2e/znc.conf defines tester1..tester8,
// each with one `ergo` network; a test leases one exclusively (lock file per
// user, shared by every Playwright worker AND every concurrently running
// suite on this machine, since they all talk to the same container), resets
// it to its initial state, and releases it afterwards.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { STACK } from '../stack';
import { IrcPeer } from '../irc-peer';

export interface ZncUser {
  host: string;
  port: number;
  username: string;
  password: string;
  network: string;
}

export interface ZncLease extends ZncUser {
  release: () => void;
}

const LOCK_DIR = join(tmpdir(), 'boson-e2e-znc-leases');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryLock(user: string): boolean {
  const file = join(LOCK_DIR, `${user}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Held — unless its owner died without releasing (killed run).
      const owner = Number(readFileSync(file, 'utf8').trim() || '0');
      if (owner > 0 && alive(owner)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

// Leases a free ZNC user, starting the search at `preferred` (pass the
// Playwright workerIndex so workers spread out). Waits up to `timeoutMs` for
// one to free up.
export async function leaseZncUser(preferred = 0, timeoutMs = 60_000): Promise<ZncLease> {
  mkdirSync(LOCK_DIR, { recursive: true });
  const users = STACK.znc.users;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < users.length; i++) {
      const username = users[(preferred + i) % users.length]!;
      if (!tryLock(username)) continue;
      let released = false;
      return {
        host: STACK.znc.host,
        port: STACK.znc.port,
        username,
        password: STACK.znc.password,
        network: STACK.znc.network,
        release: () => {
          if (released) return;
          released = true;
          rmSync(join(LOCK_DIR, `${username}.lock`), { force: true });
        },
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no free ZNC user among ${users.join(', ')} after ${timeoutMs}ms (stale locks live in ${LOCK_DIR})`);
}

// Puts a ZNC user's network back to its initial state — off the upstream
// (IRCConnectEnabled=false) and with no remembered channels — via a
// throwaway client, so bouncer specs are repeatable against a long-lived
// container.
export async function resetZncUser(u: ZncUser): Promise<void> {
  const admin = await IrcPeer.connect({
    host: u.host, port: u.port, nick: `zncadm${randomBytes(2).toString('hex')}`,
    pass: `${u.username}/${u.network}:${u.password}`,
  });
  try {
    const from = admin.mark();
    admin.privmsg('*status', 'disconnect');
    // Either "Disconnected from IRC…" or "You are currently disconnected…".
    await admin.waitFor(
      (l) => l.prefix.startsWith('*status') && /disconnected/i.test(l.params[1] ?? ''),
      10_000, '*status disconnect ack', from,
    );
    const delFrom = admin.mark();
    admin.privmsg('*controlpanel', `DelChan ${u.username} ${u.network} #*`);
    await admin.waitFor(
      (l) => l.prefix.startsWith('*controlpanel'), 10_000, '*controlpanel DelChan reply', delFrom,
    );
  } finally {
    await admin.quit();
  }
}
