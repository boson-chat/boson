// Chat-feature helpers for the real-app e2e suite (chat-*.spec.ts): get a
// guest connected to the e2e ergo in one call, find conversations in the
// sidebar, and talk to the composer the way a user does (keyboard).
import type { Locator, Page } from '@playwright/test';
import type { App } from '../desktop-app';
import { expect } from '@playwright/test';
import { IrcPeer, type IrcLine } from '../irc-peer';
import { STACK } from '../stack';

const IRC_HOST = process.env['E2E_IRC_HOST'] ?? STACK.irc.host;
const IRC_PORT = Number(process.env['E2E_IRC_PORT'] ?? STACK.irc.port);

const uid = (len = 6): string => Math.random().toString(16).slice(2, 2 + len).padEnd(len, '0');

export interface ConnectedGuest {
  app: App;
  page: Page;
  nick: string;
  serverName: string;
  openedExternally: () => Promise<string[]>;
}

type Launch = (opts?: { env?: Record<string, string> }) => Promise<{
  app: App;
  page: Page;
  openedExternally: () => Promise<string[]>;
}>;

// Guest login → add the e2e ergo by hand (or `port`, e.g. a test proxy) →
// Connect → wait for the chat layout's "connected" dot.
export async function connectGuest(
  launchApp: Launch,
  opts: { nick?: string; port?: number; env?: Record<string, string> } = {},
): Promise<ConnectedGuest> {
  const nick = opts.nick ?? `app${uid()}`;
  const serverName = `Chat Ergo ${uid(4)}`;
  const { app, page, openedExternally } = await launchApp(opts.env ? { env: opts.env } : undefined);
  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await page.getByPlaceholder('your-nick').fill(nick);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Server Directory' })).toBeVisible({ timeout: 20_000 });
  await addServerAndConnect(page, serverName, opts.port ?? IRC_PORT);
  return { app, page, nick, serverName, openedExternally };
}

export async function addServerAndConnect(page: Page, serverName: string, port = IRC_PORT): Promise<void> {
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('button', { name: '+ Add server manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a server manually' });
  const input = (label: string): Locator => dialog
    .locator('.bds-field')
    .filter({ has: page.locator('label.bds-field-label', { hasText: new RegExp(`^\\s*${label}(\\s*\\(optional\\))?\\s*$`) }) })
    .locator('input')
    .first();
  await input('Hostname').fill(IRC_HOST);
  await input('Port').fill(String(port));
  await input('Display name').fill(serverName);
  const tls = dialog.getByRole('checkbox', { name: 'Use TLS (recommended)' });
  if (await tls.isChecked()) await dialog.getByText('Use TLS (recommended)').click();
  await dialog.getByRole('button', { name: /^Add/ }).click();
  await expect(dialog).toBeHidden();
  await page.locator('article.directory-card').filter({ hasText: serverName }).getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
}

export function peerNick(prefix = 'peer'): string {
  return `${prefix}${uid()}`;
}

export function connectPeer(nick = peerNick(), caps?: string[]): Promise<IrcPeer> {
  return IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick, caps });
}

// The textarea of the active conversation (whatever its name).
export function input(page: Page): Locator {
  return page.locator('textarea.chat-textarea');
}

// Type into the composer like a user and press Enter.
export async function say(page: Page, text: string): Promise<void> {
  const box = input(page);
  await box.click();
  await box.fill(text);
  await dismissPopups(page);
  await box.press('Enter');
}

// Close an open slash / @mention / #channel autocomplete (Escape) so the next
// Enter sends instead of accepting a completion.
export async function dismissPopups(page: Page): Promise<void> {
  const popup = page.locator('.chat-input-bar [role="listbox"]');
  if (await popup.count() > 0) await input(page).press('Escape');
}

// A slash command: typed, any autocomplete popup dismissed, Enter. Resolves
// once the composer cleared (the command was submitted).
export async function command(page: Page, line: string): Promise<void> {
  const box = input(page);
  await box.click();
  await box.fill(line);
  await dismissPopups(page);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

export function sidebar(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Channels' });
}

// A sidebar row (channel or DM) by its display name (no # / [DM] prefix).
export function conversation(page: Page, name: string): Locator {
  const display = name.replace(/^[#&]/, '');
  return sidebar(page).locator('.channel-item').filter({
    has: page.locator('.channel-name', { hasText: new RegExp(`^${escapeRe(display)}$`, 'i') }),
  });
}

export function messages(page: Page): Locator {
  return page.locator('main .chat-messages');
}

export function members(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Members' });
}

export function memberRow(page: Page, nick: string): Locator {
  return members(page).locator('.user-panel-item').filter({
    has: page.locator('.user-panel-name', { hasText: new RegExp(`^${escapeRe(nick)}$`) }),
  });
}

export function banner(page: Page): Locator {
  return page.locator('.chat-banner-error');
}

// Join via the sidebar's "+" (the only way in before any conversation is
// open — the composer only exists inside one) and wait until it's active
// with us in its member list.
export async function joinViaUi(page: Page, channel: string, myNick: string): Promise<void> {
  await page.getByRole('button', { name: 'Add channel' }).click();
  const box = page.getByPlaceholder('Search channels by name or topic — or type #channel to join directly');
  await box.fill(channel);
  await box.press('Enter');
  await expect(page.getByPlaceholder(new RegExp(`^Message #${escapeRe(channel.replace(/^#/, ''))}$`, 'i'))).toBeVisible({ timeout: 20_000 });
  await expect(memberRow(page, myNick)).toBeVisible({ timeout: 20_000 });
}

// Join via the composer and wait until the channel is active and its member
// list has us (NAMES landed).
export async function joinViaCommand(page: Page, channel: string, myNick: string): Promise<void> {
  await say(page, `/join ${channel}`);
  await expect(page.getByPlaceholder(new RegExp(`^Message #${escapeRe(channel.replace(/^#/, ''))}$`, 'i'))).toBeVisible({ timeout: 20_000 });
  await expect(memberRow(page, myNick)).toBeVisible({ timeout: 20_000 });
}

export function fromNick(l: IrcLine): string {
  return l.prefix.split('!')[0] ?? '';
}

// Waits for a line `cmd` from `nick` (after `from`), optional extra check.
export function waitCmd(
  peer: IrcPeer,
  cmd: string,
  nick: string,
  match: (l: IrcLine) => boolean = () => true,
  from = 0,
  // Generous: the engine's IRC library paces outgoing lines (girc flood
  // control, ~1 line/s once a burst used up its allowance — and connect +
  // join already send a burst), so a command can reach the wire seconds
  // after Enter.
  timeoutMs = 45_000,
): Promise<IrcLine> {
  return peer.waitFor(
    (l) => l.command === cmd && fromNick(l).toLowerCase() === nick.toLowerCase() && match(l),
    timeoutMs,
    `${cmd} from ${nick}`,
    from,
  );
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
