import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { VoiceController, getVoiceSettings, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../../modules/voice/voice.fake';
import { __resetVoiceSettings } from '../../modules/voice/voice.settings';
import { MobileCallScreen, MobileMiniBar } from './MobileCall';
import { setVoiceUi, useVoiceUi } from './VoiceRooms';

let bridge: FakeVoiceBridge;
let controller: VoiceController;

const ALICE = { sessionId: 3, userId: 'usr_alice', name: 'alice', self: false, muted: false, deafened: false, speaking: true, volume: 100 };

async function joined(): Promise<void> {
  await act(async () => { await controller.join('irc.boson.chat', { id: 'general', name: 'General' }, 'boson'); });
  act(() => bridge.push({ participants: [...bridge.current.participants, ALICE], route: 'speaker' }));
}

describe('the call on a phone: the minimized bar and the call screen', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetVoiceSettings();
    bridge = createFakeVoiceBridge({ servers: { 'irc.boson.chat': {} } });
    controller = new VoiceController(bridge, {
      authUrl: 'https://auth.boson.chat',
      voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }),
      keyTarget: null,
    });
    setVoiceController(controller);
  });
  afterEach(() => { setVoiceController(null); setVoiceUi({ view: null }); });

  it('shows nothing outside a call', () => {
    const { container } = render(<MobileMiniBar />);
    expect(container.innerHTML).toBe('');
  });

  it('minimized: who and where, mute, open and leave', async () => {
    let view: unknown = null;
    function Probe() { view = useVoiceUi().view; return null; }
    render(<><MobileMiniBar /><Probe /></>);
    await joined();
    expect(screen.getByText('General · 2')).toBeTruthy();
    expect(screen.getByText('38 ms')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(bridge.calls).toContainEqual({ method: 'setMuted', args: [true] }));
    expect(screen.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Open call' }));
    expect(view).toEqual({ host: 'irc.boson.chat', roomId: 'general', serverName: 'boson' });
    fireEvent.click(screen.getByRole('button', { name: 'Leave call' }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === 'leave')).toBe(true));
    await waitFor(() => expect(screen.queryByText('General · 2')).toBeNull());
  });

  it('says when a phone call has paused it', async () => {
    render(<MobileMiniBar />);
    await joined();
    act(() => bridge.push({ interrupted: true }));
    expect(screen.getByText('Paused while another call has the audio')).toBeTruthy();
  });

  it('More: audio output, deafen, people and volume, and screen sharing "soon on phones"', async () => {
    render(<MobileCallScreen />);
    await joined();
    expect(screen.getByText('General')).toBeTruthy();
    expect(screen.getByLabelText('Your video')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    await screen.findByRole('dialog', { name: 'Call options' });
    expect((screen.getByRole('button', { name: /Share screen/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Audio output/ }));
    await waitFor(() => expect(bridge.calls).toContainEqual({ method: 'setSpeaker', args: [false] }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Audio output/ }).textContent).toContain('Earpiece'));
    fireEvent.click(screen.getByRole('button', { name: /Deafen/ }));
    await waitFor(() => expect(bridge.calls).toContainEqual({ method: 'setDeafened', args: [true] }));
    // Per-person volume and the mic mode live in the people sheet.
    fireEvent.click(screen.getByRole('button', { name: /People and volume/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Voice call: General' });
    expect(sheet.textContent).toContain('me (you)');
    fireEvent.click(screen.getByRole('button', { name: /alice: speaking/ }));
    fireEvent.input(screen.getByLabelText('Volume for alice'), { target: { value: '150' } });
    expect(getVoiceSettings().userVolumes.usr_alice).toBe(150);
    await waitFor(() => expect(bridge.calls).toContainEqual({ method: 'setUserVolume', args: ['usr_alice', 150] }));
  });

  it('a headset takes the sound: Audio output shows it and is off', async () => {
    render(<MobileCallScreen />);
    await joined();
    act(() => bridge.push({ route: 'bluetooth' }));
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const btn = await screen.findByRole('button', { name: /Audio output/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.textContent).toContain('Bluetooth');
  });

  it('push to talk: the hold button sits above the dock', async () => {
    render(<MobileCallScreen />);
    await joined();
    expect(screen.queryByRole('button', { name: 'Hold to talk' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(await screen.findByRole('button', { name: /People and volume/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Push to talk' }));
    await waitFor(() => expect(bridge.calls).toContainEqual({ method: 'setInputMode', args: ['ptt'] }));
    const holds = await screen.findAllByRole('button', { name: 'Hold to talk' });
    fireEvent.pointerDown(holds[0], { pointerId: 1 });
    expect(controller.talking).toBe(true);
    fireEvent.pointerUp(holds[0], { pointerId: 1 });
    expect(controller.talking).toBe(false);
  });

  it('shows a failure with retry and dismiss', async () => {
    render(<MobileMiniBar />);
    await joined();
    act(() => bridge.push({ status: 'error', errorKind: 'mic', error: "Boson can't use your microphone. Turn on Microphone for Boson in Settings, then try again." }));
    expect(screen.getByRole('alert').textContent).toContain('Turn on Microphone for Boson in Settings');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    act(() => bridge.push({ errorKind: 'dropped', error: 'Lost the connection to the voice server.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === 'join').length).toBe(2));
    act(() => bridge.push({ status: 'error', errorKind: 'dropped', error: 'x' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === 'dismissError')).toBe(true));
  });
});

describe('VoiceController on phones', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetVoiceSettings();
    bridge = createFakeVoiceBridge({ servers: { 'irc.boson.chat': {} } });
    controller = new VoiceController(bridge, {
      authUrl: 'https://auth.boson.chat',
      voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }),
      keyTarget: null,
    });
    setVoiceController(controller);
  });
  afterEach(() => setVoiceController(null));

  it('hold to talk only does anything in push-to-talk mode during a call', async () => {
    const ptts = (): unknown[] => bridge.calls.filter((c) => c.method === 'ptt').map((c) => c.args[0]);
    controller.setInputMode('ptt');
    controller.holdToTalk(true);
    expect(ptts()).toEqual([]); // no call
    await controller.join('irc.boson.chat', { id: 'general', name: 'General' });
    controller.setInputMode('vad');
    controller.holdToTalk(true);
    expect(ptts()).toEqual([]); // open mic
    controller.setInputMode('ptt');
    controller.holdToTalk(true);
    controller.holdToTalk(true);
    expect(ptts()).toEqual([true]);
  });

  it('lets go of push to talk when the app goes to the background', async () => {
    await controller.join('irc.boson.chat', { id: 'general', name: 'General' });
    controller.setInputMode('ptt');
    controller.holdToTalk(true);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
    expect(controller.talking).toBe(false);
    expect(bridge.calls.filter((c) => c.method === 'ptt').map((c) => c.args[0])).toEqual([true, false]);
  });

  it('setSpeaker goes to the shell; without one it does nothing', async () => {
    await controller.setSpeaker(false);
    expect(controller.getSnapshot().call.speaker).toBe(false);
    expect(bridge.calls).toContainEqual({ method: 'setSpeaker', args: [false] });
    const bare = createFakeVoiceBridge();
    delete (bare as { setSpeaker?: unknown }).setSpeaker;
    const c = new VoiceController(bare, { authUrl: 'https://auth.boson.chat', voiceToken: async () => ({ token: 't', expiresAt: 0 }), keyTarget: null });
    await c.setSpeaker(false);
    expect(c.getSnapshot().call.speaker).toBe(true);
    c.dispose();
  });
});
