// NickServ account flows through Server settings → Identity, against the
// e2e ergo's built-in NickServ (email verification on; codes land in the
// catch-all Mailpit). Every outcome is checked on the IRC side too, through
// a raw peer (WHOIS → RPL_WHOISACCOUNT, NickServ INFO).
import type { Locator, Page } from '@playwright/test';
import {
  test, expect, IRC_HOST, IRC_PORT, continueAsGuest, field, joinChannel, memberList, randomChannel, randomNick,
  serverCard, uid,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import {
  accountBadge, closeServerSettings, expectConnected, expectWhoisAccount, guestOnErgo, nickServInfo, openServerSettings,
  preregisterAccount, registerPeerAccount, servicesBadge, verificationCode, whoisAccount,
} from './helpers/services';

test('guest registers a NickServ account, verifies the emailed code, and drops it', async ({ launchApp }) => {
  const nick = randomNick('svc');
  const password = `pw-${uid(10)}`;
  const email = `${nick}@example.test`;
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('obs') });
  try {
    const { page } = await launchApp();
    await guestOnErgo(page, nick);
    const settings = await openServerSettings(page, 'Identity');

    // The engine's post-welcome VERSION probe got ergo's "/NS HELP" reply.
    await expect(servicesBadge(settings)).toHaveText('Ergo (built-in)', { timeout: 20_000 });
    await expect(settings.getByText('No account saved for this server yet.')).toBeVisible();
    // Guests have no Boson account: no backend claim, no E2E-sync promise.
    await expect(settings.getByRole('button', { name: /^Claim / })).toHaveCount(0);
    await expect(settings.getByText('syncs (end-to-end encrypted)', { exact: false })).toHaveCount(0);

    await field(settings, 'Password').fill(password);
    await field(settings, 'Email').fill(email);
    await settings.getByRole('button', { name: 'Register new account' }).click();
    await expect(settings.getByRole('status').filter({ hasText: `Check ${email} for a confirmation code.` })).toBeVisible();
    await expect(accountBadge(settings)).toHaveText('Confirm your email');
    await expect(settings.getByText(`Registered ${nick} with ${email}.`)).toBeVisible();

    // A wrong code is rejected and the form stays up.
    const codeBox = settings.getByPlaceholder('paste the code from your email');
    await codeBox.fill('notthecode');
    await settings.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(settings.getByRole('alert').filter({ hasText: 'Code rejected.' })).toBeVisible();
    expect(await whoisAccount(peer, nick)).toBeNull();

    // The real one (ergo mailed it to the catch-all) confirms + logs us in.
    await codeBox.fill(await verificationCode(email));
    await settings.getByRole('button', { name: 'Confirm', exact: true }).click();
    // (The confirm form, and its "Account confirmed." line, unmount as soon as the
    // badge flips to Identified.)
    await expect(accountBadge(settings)).toHaveText('Identified');
    await expect(settings.getByText(`Identified as ${nick}.`)).toBeVisible();
    await expectWhoisAccount(peer, nick, nick);
    expect((await nickServInfo(peer, nick)).join('\n')).toContain(`Account: ${nick}`);

    // Drop: two-step confirm, then ergo's UNREGISTER + token replay.
    await settings.getByRole('button', { name: 'Drop account' }).click();
    await expect(settings.getByText(`Drop ${nick} on this network? This is irreversible.`)).toBeVisible();
    await settings.getByRole('button', { name: 'Yes, drop it' }).click();
    // Ergo kills a connection that unregisters the account it's logged into;
    // the app takes that as the success signal and forgets the password.
    await expect(settings.getByRole('button', { name: 'Drop account' })).toBeVisible();
    await expect(settings.getByRole('alert')).toBeHidden();
    await expect(accountBadge(settings)).toHaveText('No account');
    await expect(field(settings, 'Password')).toHaveValue('');
    expect((await nickServInfo(peer, nick)).join('\n')).toMatch(/Name reserved due to a prior registration|Account does not exist/);
    // …and auto-reconnects, not logged in to anything.
    await closeServerSettings(page);
    await expectConnected(page);
    await expectWhoisAccount(peer, nick, null);
  } finally {
    await peer.quit();
  }
});

test('saved NickServ password: wrong one is rejected, right one identifies, and it auto-identifies on relaunch', async ({ launchApp }) => {
  const nick = randomNick('idf');
  const password = `pw-${uid(10)}`;
  await preregisterAccount(nick, password);
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('obs') });
  try {
    const first = await launchApp();
    let page = first.page;
    await guestOnErgo(page, nick);
    let settings = await openServerSettings(page, 'Identity');

    // Wrong password → NickServ rejects it.
    await field(settings, 'Password').fill('definitely-wrong');
    await credsForm(settings).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Saved', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Identify now' }).click();
    await expect(settings.getByRole('alert').filter({ hasText: 'Password rejected.' })).toBeVisible();
    await expect(accountBadge(settings)).toHaveText('Identify failed');
    await expect(settings.getByText('Last identify was rejected.', { exact: false })).toBeVisible();
    expect(await whoisAccount(peer, nick)).toBeNull();

    // Right password → identified.
    await field(settings, 'Password').fill(password);
    await credsForm(settings).getByRole('button', { name: 'Save', exact: true }).click();
    await settings.getByRole('button', { name: 'Identify now' }).click();
    await expect(settings.getByRole('status').filter({ hasText: 'Identified.' })).toBeVisible();
    await expect(accountBadge(settings)).toHaveText('Identified');
    await expectWhoisAccount(peer, nick, nick);

    // Relaunch: the saved password (secure store) is sent as IDENTIFY right
    // after the welcome, with no user action.
    await first.app.close();
    await expectWhoisAccount(peer, nick, null);
    const second = await launchApp();
    page = second.page;
    await expectConnected(page);
    await expectWhoisAccount(peer, nick, nick);
    settings = await openServerSettings(page, 'Identity');
    await expect(accountBadge(settings)).toHaveText('Identified');
    await expect(field(settings, 'Password')).toHaveValue(password);
  } finally {
    await peer.quit();
  }
});

// The NickServ credentials form (the nick-change form above it has its own Save).
function credsForm(settings: Locator): Locator {
  return settings.locator('form.user-settings-form');
}

test('member hover cards show services accounts (extended-join and account-notify)', async ({ launchApp }) => {
  const nick = randomNick('acv');
  const channel = randomChannel('acct');
  const knownNick = randomNick('known');
  const knownPw = `pw-${uid(10)}`;
  await preregisterAccount(knownNick, knownPw);
  const known = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: knownNick });
  const fresh = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('fresh') });
  try {
    const { page } = await launchApp();
    await guestOnErgo(page, nick);
    await joinChannel(page, channel);

    // Already logged in when it joins → extended-join carries the account.
    const mark = known.mark();
    known.privmsg('NickServ', `IDENTIFY ${knownPw}`);
    await known.waitFor((l) => l.command === 'NOTICE' && /now logged in/.test(l.params[1] ?? ''), 15_000, 'identify', mark);
    await known.join(channel);
    await fresh.join(channel);
    // The peer's own JOIN echo can beat the app's: wait for fresh's row before
    // hovering. It sorts above known's, so if it rendered after the hover it
    // would slide in under the stationary pointer and take over the card.
    await expect(memberRow(page, fresh.nick)).toBeVisible();

    const card = page.getByRole('tooltip');
    await memberRow(page, knownNick).hover();
    await expect(card).toContainText(knownNick);
    await expect(card.locator('.nick-hovercard-meta-row').filter({ hasText: 'Account' })).toHaveText(`Account${knownNick}`);
    await page.mouse.move(0, 0);

    await memberRow(page, fresh.nick).hover();
    await expect(card).toContainText(fresh.nick);
    await expect(card.locator('.nick-hovercard-meta-row').filter({ hasText: 'Account' })).toHaveCount(0);
    await page.mouse.move(0, 0);

    // Registering + verifying logs it in mid-channel → account-notify.
    await registerPeerAccount(fresh, `pw-${uid(10)}`);
    await expect(async () => {
      await page.mouse.move(0, 0);
      await memberRow(page, fresh.nick).hover();
      await expect(card.locator('.nick-hovercard-meta-row').filter({ hasText: 'Account' })).toHaveText(`Account${fresh.nick}`, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  } finally {
    await known.quit();
    await fresh.quit();
  }
});

function memberRow(page: Page, nick: string): Locator {
  return memberList(page).locator('.user-panel-item').filter({
    has: page.locator('.user-panel-name', { hasText: new RegExp(`^${nick}$`) }),
  });
}

test('Advanced → NickServ / ChanServ commands show the services reply inline', async ({ launchApp }) => {
  const nick = randomNick('adv');
  const password = `pw-${uid(10)}`;
  await preregisterAccount(nick, password);
  const { page } = await launchApp();
  await guestOnErgo(page, nick);
  const settings = await openServerSettings(page, 'Advanced');

  // NickServ: IDENTIFY (password input) → logged in; the Identity badge follows.
  await settings.getByRole('tab', { name: 'NickServ', exact: true }).click();
  const identify = commandRow(settings, 'IDENTIFY');
  await identify.locator('input').fill(password);
  await identify.getByRole('button', { name: 'Identify' }).click();
  await expect(identify.locator('.server-settings-cmd-output')).toContainText(`You're now logged in as ${nick}`);
  const info = commandRow(settings, 'INFO');
  await info.getByPlaceholder('nick').fill(nick);
  await info.getByRole('button', { name: 'Info' }).click();
  await expect(info.locator('.server-settings-cmd-output')).toContainText(`Account: ${nick}`);
  await expect(info.locator('.server-settings-cmd-output')).toContainText(`Email address: ${nick}@example.test`);

  // ChanServ: the e2e ergo has channel registration switched off.
  await settings.getByRole('tab', { name: 'ChanServ', exact: true }).click();
  const csRegister = commandRow(settings, 'REGISTER');
  await csRegister.getByPlaceholder('#channel').fill(randomChannel('cs'));
  await csRegister.getByRole('button', { name: 'Register' }).click();
  await expect(csRegister.locator('.server-settings-cmd-output')).toContainText('disabled by the server administrators');

  await settings.getByRole('tab', { name: /^Identity/ }).click();
  await expect(accountBadge(settings)).toHaveText('Identified');
});

// One Advanced command (label + inputs + its captured-output panel).
function commandRow(settings: Locator, label: string): Locator {
  return settings.locator('form.server-settings-cmd-row')
    .filter({ has: settings.page().locator('.server-settings-cmd-label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('xpath=..');
}

// Directory → Advanced → "+ Add server manually" with the optional login
// fields filled → Connect.
async function addAndConnectWithLogin(
  page: Page,
  login: { saslUser?: string; saslPass?: string; nickservPass?: string },
): Promise<string> {
  const name = `Login Ergo ${uid(4)}`;
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('button', { name: '+ Add server manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a server manually' });
  await field(dialog, 'Hostname').fill(IRC_HOST);
  await field(dialog, 'Port').fill(String(IRC_PORT));
  await field(dialog, 'Display name').fill(name);
  const tls = dialog.getByRole('checkbox', { name: 'Use TLS (recommended)' });
  if (await tls.isChecked()) await dialog.getByText('Use TLS (recommended)').click();
  if (login.saslUser) await field(dialog, 'SASL account').fill(login.saslUser);
  if (login.saslPass) await field(dialog, 'SASL password').fill(login.saslPass);
  if (login.nickservPass) await field(dialog, 'NickServ password').fill(login.nickservPass);
  await dialog.getByRole('button', { name: /^Add/ }).click();
  await expect(dialog).toBeHidden();
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page);
  return name;
}

test('SASL PLAIN credentials from the add-server dialog log in during registration', async ({ launchApp }) => {
  const account = randomNick('sasl');
  const password = `pw-${uid(10)}`;
  await preregisterAccount(account, password);
  const nick = randomNick('sas');
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('obs') });
  try {
    const { page } = await launchApp();
    await continueAsGuest(page, nick);
    await addAndConnectWithLogin(page, { saslUser: account, saslPass: password });
    // Logged in to the account (not the nick) before any NickServ traffic.
    await expectWhoisAccount(peer, nick, account);
    const settings = await openServerSettings(page, 'Info');
    await expect(settings.getByText('sasl', { exact: true })).toBeVisible();
  } finally {
    await peer.quit();
  }
});

test('a NickServ password given when adding the server auto-identifies on connect', async ({ launchApp }) => {
  const nick = randomNick('nsp');
  const password = `pw-${uid(10)}`;
  await preregisterAccount(nick, password);
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('obs') });
  try {
    const { page } = await launchApp();
    await continueAsGuest(page, nick);
    await addAndConnectWithLogin(page, { nickservPass: password });
    await expectWhoisAccount(peer, nick, nick);
    const settings = await openServerSettings(page, 'Identity');
    await expect(accountBadge(settings)).toHaveText('Identified');
    await expect(field(settings, 'Password')).toHaveValue(password);
  } finally {
    await peer.quit();
  }
});
