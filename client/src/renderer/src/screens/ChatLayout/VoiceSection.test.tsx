import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { AuthProvider, type AuthService } from '../../modules/auth';
import { VoiceController, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../../modules/voice/voice.fake';
import { __resetVoiceSettings } from '../../modules/voice/voice.settings';
import { VoiceSection } from './VoiceSection';
import { VoiceBar } from './VoiceBar';

function fakeAuth(signedIn: boolean): AuthService {
  const state = {
    session: signedIn ? { access_token: 'a', expires_at: 0, refresh_token: 'r', session_id: 's', user: { id: 'usr_me', username: 'me', email: null, email_verified: true, role: 'user', user_metadata: {} } } : null,
    loading: false, error: null,
  };
  return { getState: () => state, subscribe: (fn: (s: unknown) => void) => { fn(state); return () => {}; } } as unknown as AuthService;
}

const ROOMS = [
  { id: 'general', name: 'General', participants: [
    { sessionId: 3, userId: 'usr_alice', name: 'alice', muted: false, deafened: false, speaking: true },
    { sessionId: 4, userId: 'usr_bob', name: 'bob', muted: true, deafened: false, speaking: false },
  ] },
  { id: 'music', name: 'Music', participants: [] },
];

let bridge: FakeVoiceBridge;
let controller: VoiceController;

function mount(host: string, signedIn = true) {
  return render(
    <AuthProvider service={fakeAuth(signedIn)}>
      <VoiceSection host={host} serverName="boson" engineState="connected" />
      <VoiceBar />
    </AuthProvider>,
  );
}

describe('VoiceSection', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetVoiceSettings();
    bridge = createFakeVoiceBridge({ servers: { 'irc.boson.chat': {} }, rooms: { 'irc.boson.chat': ROOMS } });
    controller = new VoiceController(bridge, {
      authUrl: 'https://auth.boson.chat',
      voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }),
      pollMs: 60_000,
      keyTarget: null,
    });
    setVoiceController(controller);
  });
  afterEach(() => setVoiceController(null));

  it('lists voice channels and who is in them on a server with voice', async () => {
    mount('irc.boson.chat');
    await screen.findByText('Voice');
    await screen.findByText('General');
    expect(screen.getByText('Music')).toBeTruthy();
    // Before joining: just faces (the speaker's ringed), no names.
    const peek = screen.getByRole('button', { name: /2 in call: show who's in General/ });
    expect(peek.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.voice-face[data-speaking]')).toBeTruthy();
    expect(screen.queryByLabelText('alice: speaking')).toBeNull();
    // Peek: who's in, without joining.
    fireEvent.click(peek);
    expect(screen.getByLabelText('alice: speaking')).toBeTruthy();
    expect(screen.getByLabelText('bob: muted')).toBeTruthy();
    expect(document.querySelector('.voice-avatar[data-speaking]')).toBeTruthy();
    expect(bridge.calls.some((c) => c.method === 'join')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /hide who's in General/ }));
    expect(screen.queryByLabelText('alice: speaking')).toBeNull();
  });

  it('shows nothing on a server without voice', async () => {
    const { container } = mount('irc.ircforever.org');
    await waitFor(() => expect(bridge.calls.some((c) => c.method === 'discover')).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.querySelector('.voice-section')).toBeNull();
    expect(screen.queryByText('Voice')).toBeNull();
  });

  it('shows nothing for a guest', async () => {
    const { container } = mount('irc.boson.chat', false);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.querySelector('.voice-section')).toBeNull();
    expect(bridge.calls.some((c) => c.method === 'discover')).toBe(false);
  });

  it('joins on click and shows the connected bar', async () => {
    mount('irc.boson.chat');
    fireEvent.click(await screen.findByLabelText('Join voice channel Music'));
    await screen.findByText(/^Connected/);
    expect(screen.getByText('Music / boson')).toBeTruthy();
    expect(screen.getByLabelText('Music (connected)')).toBeTruthy();
    // Our live roster replaces the polled one for the room we're in, and
    // shows without a peek once we're in.
    expect(screen.getByLabelText('me (you)')).toBeTruthy();
    expect(screen.getByRole('button', { name: /in call: hide who's in Music/ }).hasAttribute('disabled')).toBe(true);
    // Red tint while muted or deafened.
    expect(screen.getByLabelText('Mute').hasAttribute('data-off')).toBe(false);

    fireEvent.click(screen.getByLabelText('Mute'));
    await waitFor(() => expect(screen.getByLabelText('Unmute')).toBeTruthy());
    expect(screen.getByLabelText('Unmute').hasAttribute('data-off')).toBe(true);
    fireEvent.click(screen.getByLabelText('Deafen'));
    await waitFor(() => expect(screen.getByLabelText('Undeafen')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Leave call'));
    await waitFor(() => expect(screen.queryByText(/^Connected/)).toBeNull());
  });

  it('shows a join error with retry and dismiss', async () => {
    bridge.opts.onJoin = (req, prev) => ({ ...prev, status: 'error', host: req.host, room: req.room, roomName: req.roomName, error: "Couldn't reach the voice server.", errorKind: 'unreachable' });
    mount('irc.boson.chat');
    fireEvent.click(await screen.findByLabelText('Join voice channel General'));
    await screen.findByText("Couldn't reach the voice server.");
    expect(screen.getByLabelText('Try again')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    await waitFor(() => expect(screen.queryByText('Voice failed')).toBeNull());
  });

  it('shows a room-list error inline with retry', async () => {
    bridge.opts.rooms = { 'irc.boson.chat': { rooms: null, error: "This voice server doesn't list its channels yet.", errorKind: 'unavailable' } };
    mount('irc.boson.chat');
    await screen.findByText("This voice server doesn't list its channels yet.");
    const n = bridge.calls.filter((c) => c.method === 'rooms').length;
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === 'rooms').length).toBe(n + 1));
  });

  it('right-click a participant for their volume', async () => {
    mount('irc.boson.chat');
    fireEvent.click(await screen.findByRole('button', { name: /show who's in General/ }));
    fireEvent.contextMenu(await screen.findByLabelText('alice: speaking'), { clientX: 10, clientY: 10 });
    const slider = await screen.findByLabelText('Volume for alice');
    fireEvent.input(slider, { target: { value: '150' } });
    expect(bridge.calls).toContainEqual({ method: 'setUserVolume', args: ['usr_alice', 150] });
    expect(screen.getByText('150%')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Volume for alice')).toBeNull());
  });

  it('re-checks discovery when the server reconnects', async () => {
    const { rerender } = mount('irc.boson.chat');
    await screen.findByText('General');
    const tree = (state: 'connected' | 'disconnected') => (
      <AuthProvider service={fakeAuth(true)}>
        <VoiceSection host="irc.boson.chat" serverName="boson" engineState={state} />
      </AuthProvider>
    );
    rerender(tree('disconnected'));
    rerender(tree('connected'));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === 'discover').map((c) => c.args[1])).toContain(true));
  });

  it('is absent without the desktop bridge', () => {
    setVoiceController(null);
    const { container } = mount('irc.boson.chat');
    expect(container.querySelector('.voice-section')).toBeNull();
    expect(vi.isMockFunction(bridge.discover)).toBe(false);
  });
  it('a tablet in push to talk gets a hold-to-talk button in the voice bar', async () => {
    window.bosonPlatform = 'ios';
    try {
      mount('irc.boson.chat');
      fireEvent.click(await screen.findByLabelText('Join voice channel General'));
      await screen.findByText(/^Connected/);
      expect(screen.queryByRole('button', { name: 'Hold to talk' })).toBeNull();
      await act(async () => { controller.setInputMode('ptt'); });
      const hold = await screen.findByRole('button', { name: 'Hold to talk' });
      fireEvent.pointerDown(hold, { pointerId: 1 });
      fireEvent.pointerUp(hold, { pointerId: 1 });
      expect(bridge.calls.filter((c) => c.method === 'ptt').map((c) => c.args[0])).toEqual([true, false]);
    } finally {
      delete window.bosonPlatform;
    }
  });
});

describe('a busy voice channel in the sidebar', () => {
  const crowd = Array.from({ length: 15 }, (_, i) => ({
    sessionId: 10 + i, userId: `usr_p${i}`, name: `p${i}`, muted: i % 4 === 1, deafened: false, speaking: i === 9,
  }));
  beforeEach(() => {
    localStorage.clear();
    __resetVoiceSettings();
    bridge = createFakeVoiceBridge({ servers: { 'irc.boson.chat': {} }, rooms: { 'irc.boson.chat': [{ id: 'general', name: 'General', participants: crowd }] } });
    controller = new VoiceController(bridge, {
      authUrl: 'https://auth.boson.chat', voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }), pollMs: 60_000, keyTarget: null,
    });
    setVoiceController(controller);
  });
  afterEach(() => setVoiceController(null));

  it('shows three faces (the speaker first) and +12, then five names and "+10 more · see all"', async () => {
    mount('irc.boson.chat');
    const peek = await screen.findByRole('button', { name: /15 in call: show who's in General/ });
    const faces = peek.querySelectorAll('.voice-face');
    expect(faces.length).toBe(3);
    expect(faces[0].hasAttribute('data-speaking')).toBe(true); // p9 speaks: first
    expect(peek.textContent).toContain('+12');
    fireEvent.click(peek);
    const names = [...document.querySelectorAll('.voice-participant .voice-participant-name')].map((e) => e.textContent);
    expect(names.length).toBe(5);
    expect(names[0]).toBe('p9'); // the speaker heads the list
    fireEvent.click(screen.getByRole('button', { name: '+10 more · see all' }));
    expect(document.querySelectorAll('.voice-participant').length).toBe(15);
  });
});

describe('roomPeople', () => {
  it('ranks you, then speakers, then sharers for a cut-down list', async () => {
    const { roomPeople } = await import('./VoiceRooms');
    const live = Array.from({ length: 9 }, (_, i) => ({ sessionId: i, userId: `u${i}`, name: `n${i}`, muted: false, deafened: false, speaking: i === 5, self: i === 7 }));
    const r = roomPeople(live, [{ userId: 'u3', kind: 'screen', self: false }, { userId: 'u2', kind: 'camera', self: false }], false, false);
    expect(r.capped.map((x) => x.p.name).slice(0, 3)).toEqual(['n7', 'n5', 'n3']);
    expect(r.capped.length).toBe(5);
    expect(r.hidden).toBe(4);
    expect(r.people.find((x) => x.p.name === 'n2')!.camera).toBe(true);
    expect(r.faces[0].p.name).toBe('n5');
    expect(r.more).toBe(6);
    // Seven or fewer: everyone, in order.
    expect(roomPeople(live.slice(0, 7), [], false, false).capped.length).toBe(7);
  });
});
