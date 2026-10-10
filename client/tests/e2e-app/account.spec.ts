// Account mode, end to end against the e2e stack (Supabase Auth + backend):
// sign up in the UI → confirmation mail → confirm via the boson:// deep link
// → sign in → pick a handle → the directory lists a seeded, verified server
// → connect → chat with a peer → relaunch restores the signed-in session.
import {
  test, expect, IRC_HOST, IRC_PORT,
  composer, confirmSignup, completeHandleSetup, findAuthUserByEmail, joinChannel, loginAs, messageList,
  randomChannel, randomEmail, randomHandle, randomNick, randomPassword, seedServer, sendMessage, serverCard,
  signUpViaUi,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import { deleteAuthUser } from './helpers/supabase';

test('sign up, confirm by email, set a handle, chat on a directory server, and stay signed in after relaunch', async ({ launchApp, backendApi }) => {
  test.setTimeout(180_000);
  const email = randomEmail('signup');
  const password = randomPassword();
  const handle = randomHandle('acct');
  const channel = randomChannel('acct');

  const seeded = await seedServer({ description: 'Seeded by account.spec' });
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('peer') });
  let userId: string | null = null;
  try {
    await peer.join(channel);

    // ---- sign up: no session until the email is confirmed ----
    const first = await launchApp();
    const { page } = first;
    await signUpViaUi(page, { email, password });
    const pending = await findAuthUserByEmail(email);
    expect(pending, 'GoTrue created the user').not.toBeNull();
    userId = pending!.id;
    expect(pending!.email_confirmed_at).toBeNull();

    // ---- confirm: mail link → /verify → boson://auth/confirmed → app ----
    await confirmSignup(first.app, email);
    expect((await findAuthUserByEmail(email))!.email_confirmed_at).not.toBeNull();
    // The deep link hands the app a session, but the identity key can only
    // be created / unlocked with the password: the app asks to sign in.
    await expect(page.getByRole('tab', { name: 'Login', selected: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeHidden();
    await expect(page.getByPlaceholder('email', { exact: true })).toHaveValue(email);

    // ---- sign in → first-sign-in handle setup → directory ----
    expect(await loginAs(page, { email, password })).toBe('setup');
    const recoveryCode = await completeHandleSetup(page, handle);
    expect(recoveryCode).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){7}$/);

    // The backend now has the user, with both secret wraps.
    const me = await (await backendApi({ email, password })).get<{ handle: string; encrypted_user_secret: string }>('/me');
    expect(me.handle).toBe(handle);
    expect(me.encrypted_user_secret.length).toBeGreaterThan(40);

    // ---- the seeded server is listed (verified) ----
    await page.getByPlaceholder('Search servers…').fill(seeded.name);
    const card = serverCard(page, seeded.name);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText('VERIFIED', { exact: true })).toBeVisible();
    await expect(card.locator('.directory-card-host')).toHaveText(`${seeded.hostname}:${seeded.port}`);

    // ---- connect as the handle and chat ----
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.sidebar-server-name')).toHaveText(seeded.name, { timeout: 30_000 });
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await joinChannel(page, channel);
    await peer.waitForJoin(channel, handle);

    const out1 = `hello from ${handle}`;
    await sendMessage(page, channel, out1);
    const got = await peer.waitForPrivmsg(channel, out1);
    expect(got.prefix.split('!')[0]).toBe(handle);
    const in1 = `hi ${handle}, welcome`;
    peer.privmsg(channel, in1);
    await expect(messageList(page).getByText(in1)).toBeVisible();

    // ---- relaunch: session + identity restored, no sign-in ----
    const quitMark = peer.mark();
    await first.app.close();
    await peer.waitFor((l) => l.command === 'QUIT' && l.prefix.split('!')[0] === handle, 20_000, `${handle} QUIT`, quitMark);

    const rejoinMark = peer.mark();
    const second = await launchApp();
    const p2 = second.page;
    await expect(composer(p2, channel)).toBeVisible({ timeout: 45_000 });
    await expect(p2.locator('.login-screen')).toBeHidden();
    await expect(p2.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await peer.waitFor(
      (l) => l.command === 'JOIN' && l.prefix.split('!')[0] === handle && (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
      30_000, `${handle} re-joining ${channel}`, rejoinMark,
    );
    const out2 = `back again ${handle}`;
    await sendMessage(p2, channel, out2);
    await peer.waitForPrivmsg(channel, out2);
  } finally {
    await peer.quit();
    if (userId) await deleteAuthUser(userId).catch(() => {});
  }
});

test('a provisioned account signs straight into the directory', async ({ launchApp, account }) => {
  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');
  await expect(page.locator('.directory-handle')).toHaveText(`@${account.handle}`);
});
