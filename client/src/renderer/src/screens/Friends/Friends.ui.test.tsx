import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { VoiceController, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge } from '../../modules/voice/voice.fake';
import { FriendsController, setFriendsController } from '../../modules/friends';
import { FakeFriendsApi } from '../../modules/friends/friends.fake';
import { PersonMenu } from './PersonMenu';
import { FriendsView } from './FriendsView';
import { CallOverlays } from './CallOverlays';
import { Toasts } from '../Notifications/Toasts';
import { setNotificationSettings, __resetNotificationSettingsCache } from '../../modules/ui/notifications.store';
import { PrivacyCalls } from '../UserSettings/PrivacySection';
import { PhonePage } from './FriendsNav';
import { CallsView, MyRailTile, MySidebar } from './MySpace';
import { getFriendsUi, openMy, setFriendsUi } from './friends-ui';

const HOST = 'irc.boson.example';
let api: FakeFriendsApi;
let ctl: FriendsController;
let voice: VoiceController;

beforeEach(async () => {
  const bridge = createFakeVoiceBridge({
    servers: { [HOST]: {} },
    rooms: { [HOST]: [
      { id: 'general', name: 'General', participants: [{ sessionId: 1, userId: 'u_k', name: 'kestrel', muted: false, deafened: false, speaking: false }] },
      { id: 'afk', name: 'AFK', participants: [] },
    ] },
  });
  voice = new VoiceController(bridge, {
    authUrl: 'https://auth.boson.chat', voiceToken: async () => ({ token: 'x', expiresAt: Date.now() + 300_000 }),
    pollMs: 3_600_000, keyTarget: null,
  });
  setVoiceController(voice);
  await voice.discover(HOST);
  api = new FakeFriendsApi({
    people: [
      { username: 'kestrel', rel: 'friend' },
      { username: 'pixel' },
      { username: 'nova', rel: 'incoming', calls: 'everyone' },
      { username: 'orbit', rel: 'blocked' },
    ],
    pollWaitMs: 5,
  });
  ctl = new FriendsController({
    api, authUrl: 'https://auth.boson.chat', signedIn: () => true, me: () => 'ada', onAccessChange: () => () => {},
    voice: () => voice, video: () => null, openCall: () => {}, toastMs: 1_000,
  });
  setFriendsController(ctl);
  ctl.start();
  setFriendsUi({ host: HOST, my: false, myView: 'friends', phone: null });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
});

afterEach(() => {
  localStorage.clear();
  __resetNotificationSettingsCache();
  setFriendsController(null);
  setVoiceController(null);
  setFriendsUi({ host: null });
});

describe('PersonMenu', () => {
  it('offers Call and Video call for a friend, then Remove friend and Block', async () => {
    render(<PersonMenu nick="kestrel" variant="menu" />);
    expect(await screen.findByRole('menuitem', { name: 'Call' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Video call' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Remove friend' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Block' })).toBeTruthy();
    expect(screen.getByText('Friend')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Video call' }));
    await waitFor(() => expect(ctl.getSnapshot().calling).toMatchObject({ video: true, status: 'calling' }));
  });

  it("explains why someone can't be called, and offers Add friend", async () => {
    render(<PersonMenu nick="pixel" variant="menu" />);
    expect(await screen.findByText('pixel only takes calls from friends. Send a friend request first.')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Call' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add friend' }));
    await waitFor(() => expect(ctl.getSnapshot().toast?.text).toBe('Friend request sent to pixel'));
  });

  it('blocked: Unblock, and the reason', async () => {
    render(<PersonMenu nick="orbit" variant="sheet" />);
    expect(await screen.findByText('You blocked orbit. Unblock them to call.')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Unblock' })).toBeTruthy();
  });

  it('phone sheet: big call buttons; accept a request', async () => {
    render(<PersonMenu nick="nova" variant="sheet" />);
    expect(await screen.findByRole('button', { name: 'Call' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Accept friend request' }));
    await waitFor(() => expect(ctl.getSnapshot().toast?.text).toBe('You and nova are now friends'));
  });

  it('nothing for yourself, or on another network', async () => {
    const { container } = render(<PersonMenu nick="ada" variant="menu" />);
    act(() => setFriendsUi({ host: 'irc.other.example' }));
    render(<PersonMenu nick="kestrel" variant="menu" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('menuitem', { name: 'Call' })).toBeNull();
  });
});

describe('FriendsView', () => {
  it('phone: each friend has Remove friend, which asks first', async () => {
    render(<FriendsView layout="phone" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove kestrel from friends' }));
    const ask = await screen.findByRole('dialog', { name: 'Remove kestrel?' });
    // Cancel keeps them.
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(ctl.getSnapshot().friends.map((f) => f.username)).toContain('kestrel');
    fireEvent.click(screen.getByRole('button', { name: 'Remove kestrel from friends' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remove kestrel?' })).getByRole('button', { name: 'Remove friend' }));
    await waitFor(() => expect(ctl.getSnapshot().friends.map((f) => f.username)).not.toContain('kestrel'));
  });

  it('says loading, not "sign in", while a signed-in account is still asking; and when its server has no friends', async () => {
    const api404 = new FakeFriendsApi({ people: [] });
    let fail = false;
    let release: () => void = () => {};
    api404.poll = () => new Promise((res, rej) => { release = () => (fail ? rej(Object.assign(new Error('404'), { status: 404 })) : res({ cursor: '', reset: false, events: [], snapshot: null })); });
    const c = new FriendsController({
      api: api404, authUrl: 'https://auth.boson.chat', signedIn: () => true, me: () => 'ada', onAccessChange: () => () => {},
      voice: () => null, video: () => null, openCall: () => {}, unsupportedRetryMs: 60_000,
    });
    setFriendsController(c);
    c.start();
    render(<FriendsView layout="desktop" />);
    expect(await screen.findByText('Loading friends…')).toBeTruthy();
    expect(screen.queryByText(/Sign in to your Boson account/)).toBeNull();
    fail = true;
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 10)); });
    expect(await screen.findByText(/aren't available with your account's server/)).toBeTruthy();
    c.dispose();
  });

  it('a guest is told to sign in', () => {
    setFriendsController(null);
    render(<FriendsView layout="desktop" />);
    expect(screen.getByText(/Sign in to your Boson account/)).toBeTruthy();
  });

  it('desktop: friends with their switch, pending, blocked, add by handle', async () => {
    render(<FriendsView layout="desktop" />);
    expect(await screen.findByText('kestrel')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'ALL · 1' })).toBeTruthy();
    expect(screen.getByLabelText('Can call me anytime')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'PENDING · 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(ctl.getSnapshot().friends.map((f) => f.username)).toContain('nova'));
    fireEvent.click(screen.getByRole('tab', { name: /BLOCKED/ }));
    expect(screen.getByText('orbit')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Add a friend by handle'), { target: { value: 'pixel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(ctl.getSnapshot().toast?.text).toBe('Friend request sent to pixel'));
  });

  it('phone: Call and Video per friend', async () => {
    render(<FriendsView layout="phone" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Call kestrel' }));
    await waitFor(() => expect(ctl.getSnapshot().calling?.peer.username).toBe('kestrel'));
  });
});

describe('CallOverlays', () => {
  it('full screen: rings with Decline, Voice only and Accept; Voice only answers without camera', async () => {
    setNotificationSettings({ incomingCalls: 'full' });
    render(<CallOverlays />);
    act(() => { api.ring('kestrel', true); });
    const card = await screen.findByRole('alertdialog', { name: 'kestrel is calling' });
    expect(card.textContent).toContain('is calling you · video');
    expect(card.closest('.fcall-backdrop')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept with voice only' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(voice.getSnapshot().call.room).toMatch(/^call:/));
  });

  it('banner (desktop default): a voice call has no Voice only; Decline', async () => {
    render(<><CallOverlays /><Toasts /></>);
    act(() => { api.ring('kestrel', false); });
    const card = await screen.findByRole('alertdialog', { name: 'kestrel is calling' });
    expect(card.classList.contains('ntoast-ring')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Accept with voice only' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Decline call' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('calling: Calling kestrel… with Cancel', async () => {
    render(<CallOverlays />);
    await act(async () => { await ctl.call('kestrel', false); });
    expect(screen.getByRole('dialog', { name: 'Calling kestrel' }).textContent).toContain('Voice call · ringing for up to 45 s');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('PrivacyCalls and navigation', () => {
  it('sets who can call me and Do not disturb', async () => {
    render(<PrivacyCalls />);
    fireEvent.click(screen.getByRole('radio', { name: 'Everyone' , checked: false }));
    await waitFor(() => expect(ctl.getSnapshot().privacy.calls).toBe('everyone'));
    expect(screen.getByText('Anyone who isn’t blocked can call you.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Do not disturb'));
    await waitFor(() => expect(ctl.getSnapshot().privacy.doNotDisturb).toBe(true));
  });

  it('a phone page has a title and a back arrow', async () => {
    let back = 0;
    render(<PhonePage title="Calls" sub="live · recent" backLabel="Back to MY" onBack={() => { back++; }}><p>body</p></PhonePage>);
    expect(screen.getByRole('heading', { name: 'Calls' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Calls' }).textContent).toContain('body');
    fireEvent.click(screen.getByRole('button', { name: 'Back to MY' }));
    expect(back).toBe(1);
  });

  it('opening Friends or Calls from MY opens them full screen on a phone', () => {
    openMy('calls');
    expect(getFriendsUi()).toMatchObject({ my: true, myView: 'calls', phone: 'calls' });
  });
});

describe('MY', () => {
  it('the rail tile is your avatar with a presence dot, and its badge counts requests and missed calls', async () => {
    let clicked = 0;
    const { container } = render(<MyRailTile nick="ada" presence="dnd" active={false} onClick={() => { clicked++; }} />);
    const tile = await screen.findByRole('button', { name: 'You: friends, calls and messages (Do not disturb; 1 friend request)' });
    expect(container.querySelector('.my-tile-dot')?.getAttribute('data-status')).toBe('dnd');
    expect(container.querySelector('.my-tile-badge')?.textContent).toBe('1');
    expect(tile.textContent).toContain('A');
    fireEvent.click(tile);
    expect(clicked).toBe(1);
  });

  it("the rail tile's badge counts unread direct messages too (what MY lists)", async () => {
    const { container } = render(<MyRailTile nick="ada" presence="online" active={false} onClick={() => {}} unreadDms={2} />);
    await screen.findByRole('button', { name: 'You: friends, calls and messages (Online; 1 friend request, 2 unread direct messages)' });
    expect(container.querySelector('.my-tile-badge')?.textContent).toBe('3');
  });

  it('the sidebar has Friends and Calls above the direct messages, and opens them', async () => {
    const opened: string[] = [];
    render(
      <MySidebar nick="ada" presence="online" view="friends" showServer
        dms={[{ serverId: 's1', serverName: 'Nebula', name: 'mira', unread: 2, mentions: 0 }, { serverId: 's2', serverName: 'Pulsar', name: 'juno', unread: 0, mentions: 0 }]}
        activeDm={null} onOpenDm={(d) => opened.push(`${d.serverId}/${d.name}`)} />,
    );
    const friends = await screen.findByRole('button', { name: 'Friends, 1 request' });
    expect(friends.getAttribute('aria-current')).toBe('page');
    const rows = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(rows).toEqual(['Friends, 1 request', 'Calls', 'mira on Nebula, 2 unread', 'juno on Pulsar']);
    fireEvent.click(screen.getByRole('button', { name: 'Calls' }));
    expect(getFriendsUi()).toMatchObject({ my: true, myView: 'calls' });
    fireEvent.click(screen.getByRole('button', { name: 'juno on Pulsar' }));
    expect(opened).toEqual(['s2/juno']);
  });

  it('Calls lists live voice channels to join and missed calls to call back, and marks them seen', async () => {
    api = new FakeFriendsApi({ people: [{ username: 'kestrel', rel: 'friend' }], missed: [{ from: 'kestrel', video: false, minutesAgo: 5 }], pollWaitMs: 5 });
    ctl = new FriendsController({
      api, authUrl: 'https://auth.boson.chat', signedIn: () => true, me: () => 'ada', onAccessChange: () => () => {},
      voice: () => voice, video: () => null, openCall: () => {}, toastMs: 1_000,
    });
    setFriendsController(ctl);
    ctl.start();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await act(async () => { await voice.refreshRooms(HOST, true); });
    const joined: string[] = [];
    render(<CallsView layout="desktop" serverNameFor={() => 'Nebula'} onJoin={(h, id) => joined.push(`${h}/${id}`)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Join General on Nebula' }));
    expect(joined).toEqual([`${HOST}/general`]);
    expect(screen.queryByText(/AFK/)).toBeNull();
    expect(await screen.findByRole('button', { name: 'Call kestrel back' })).toBeTruthy();
    await waitFor(() => expect(ctl.getSnapshot().missed).toBe(0));
  });
});
