import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { VoiceController, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../../modules/voice/voice.fake';
import { __resetVoiceSettings } from '../../modules/voice/voice.settings';
import { EMPTY_VIDEO_STATE, VideoController, setVideoController, type VideoBridge, type VideoState } from '../../modules/video';
import { VoiceJoinSheet, VoicePreJoin, hereText, personState } from './PreJoin';
import { setVoiceUi } from './VoiceRooms';

const HOST = 'irc.boson.chat';
const people = (n: number) => Array.from({ length: n }, (_, i) => ({
  sessionId: i + 1, userId: `usr_${i}`, name: ['kestrel', 'mira', 'juno', 'ash', 'bix', 'cora', 'dune'][i] ?? `p${i}`,
  muted: i === 2, deafened: false, speaking: i === 1,
}));

let bridge: FakeVoiceBridge;
let voice: VoiceController;
let vstate: VideoState;
let push: (s: VideoState) => void;
let vbridge: VideoBridge;

function setup(n: number) {
  bridge = createFakeVoiceBridge({ servers: { [HOST]: {} }, rooms: { [HOST]: [{ id: 'general', name: 'General', participants: people(n) }] } });
  voice = new VoiceController(bridge, { authUrl: 'https://auth.boson.chat', voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }), pollMs: 60_000, keyTarget: null });
  setVoiceController(voice);
  vstate = { ...EMPTY_VIDEO_STATE, canCapture: true, preview: { on: false, starting: false } };
  vbridge = {
    state: async () => vstate,
    onState: (fn) => { push = fn; return () => {}; },
    subscribe: vi.fn(async () => {}), unsubscribe: vi.fn(async () => {}),
    cameras: vi.fn(async () => []), screenSources: vi.fn(async () => []),
    setCamera: vi.fn(async (on: boolean) => { vstate = { ...vstate, camera: { on: false, starting: on } }; return vstate; }),
    setScreen: vi.fn(async () => vstate),
    previewCamera: vi.fn(async (on: boolean) => { vstate = { ...vstate, frameUrl: 'ws://x', preview: { on, starting: false, facing: 'front' } }; return vstate; }),
  };
  class NoSocket { binaryType = ''; readyState = 0; onmessage = null; onclose = null; close() {} send() {} constructor(public url: string) {} }
  setVideoController(new VideoController(vbridge, { WebSocket: NoSocket as unknown as typeof WebSocket, raf: () => 0, cancelRaf: () => {} }));
}

async function openView(expanded = false) {
  await act(async () => {
    await voice.discover(HOST);
    await voice.refreshRooms(HOST, true);
    setVoiceUi({ view: { host: HOST, roomId: 'general', serverName: 'boson', expanded } });
  });
}

beforeEach(() => { localStorage.clear(); __resetVoiceSettings(); });
afterEach(() => { setVoiceUi({ view: null }); setVoiceController(null); setVideoController(null); });

describe('hereText and personState', () => {
  it('says who is here', () => {
    expect(hereText([])).toBe("Nobody's here yet.");
    expect(hereText(['kestrel'])).toBe('kestrel is here.');
    expect(hereText(['kestrel', 'mira', 'juno'])).toBe('kestrel, mira and juno are here.');
    expect(hereText(['kestrel', 'mira', 'juno', 'ash'])).toBe('kestrel, mira, juno and 1 other is here.');
    expect(hereText(people(15).map((p) => p.name))).toBe('kestrel, mira, juno and 12 others are here.');
    expect(personState({ ...people(2)[1] })).toEqual({ text: 'speaking', tone: 'speaking' });
    expect(personState({ ...people(3)[2] }).text).toBe('muted');
    expect(personState({ ...people(1)[0] }).text).toBe('listening');
  });
});

describe('the pre-join view (desktop)', () => {
  it('shows who is there, three tiles and "+N more", and joins only on "Join call"', async () => {
    setup(15);
    render(<VoicePreJoin self="me" />);
    await openView();
    await screen.findByText('Join General');
    expect(screen.getByText('15 in call')).toBeTruthy();
    expect(document.querySelectorAll('.prejoin-tile').length).toBe(4);
    expect(screen.getByText('+12 more')).toBeTruthy();
    expect(screen.getByText(/kestrel, mira, juno and 12 others are here\./)).toBeTruthy();
    expect(bridge.calls.some((c) => c.method === 'join')).toBe(false);

    // Join muted: the choice is made before the call starts.
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Join call' }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === 'join')).toBe(true));
    const mute = bridge.calls.findIndex((c) => c.method === 'setMuted' && c.args[0] === true);
    const join = bridge.calls.findIndex((c) => c.method === 'join');
    expect(mute).toBeGreaterThanOrEqual(0);
    expect(mute).toBeLessThan(join);
    // In the call: the view gives way.
    await waitFor(() => expect(screen.queryByText('Join General')).toBeNull());
  });

  it('previews the camera when chosen, and turns it on once in the call', async () => {
    setup(3);
    render(<VoicePreJoin self="me" />);
    await openView();
    expect(screen.getByText('Your camera is off')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn camera on' }));
    await waitFor(() => expect(vbridge.previewCamera).toHaveBeenCalledWith(true, ''));
    await waitFor(() => expect(document.querySelector('.prejoin-preview-video[data-mirror]')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Join call' }));
    // The call's video comes up: the camera goes on by itself.
    vstate = { ...vstate, available: true, status: 'connected', canPublish: true, preview: { on: false, starting: false } };
    act(() => push(vstate));
    await waitFor(() => expect(vbridge.setCamera).toHaveBeenCalledWith(true, ''));
  });

  it('stops the preview when you leave without joining', async () => {
    setup(3);
    render(<VoicePreJoin self="me" />);
    await openView();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn camera on' }));
    await waitFor(() => expect(vbridge.previewCamera).toHaveBeenCalledWith(true, ''));
    act(() => setVoiceUi({ view: null }));
    await waitFor(() => expect(vbridge.previewCamera).toHaveBeenLastCalledWith(false, ''));
    expect(bridge.calls.some((c) => c.method === 'join')).toBe(false);
  });
});

describe('the join sheet (phone)', () => {
  it('lists three, then "and N more · Show all", which expands; "Show fewer" folds it', async () => {
    setup(15);
    render(<VoiceJoinSheet self="me" />);
    await openView();
    await screen.findByText('15 here now');
    expect(document.querySelectorAll('.joinsheet-person').length).toBe(3);
    expect(screen.getByText('speaking')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show everyone in General' }));
    expect(document.querySelectorAll('.joinsheet-person').length).toBe(15);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(document.querySelectorAll('.joinsheet-person').length).toBe(3);
  });

  it('opens with everyone from the sidebar\'s "see all", and joins with the choices made', async () => {
    setup(15);
    render(<VoiceJoinSheet self="me" />);
    await openView(true);
    await screen.findByText('15 here now');
    expect(document.querySelectorAll('.joinsheet-person').length).toBe(15);
    fireEvent.click(screen.getByRole('button', { name: /Mic on/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Muted/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Join call' }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === 'join')).toBe(true));
  });
});
