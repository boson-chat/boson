import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { EMPTY_VIDEO_STATE, VideoController, setVideoController, type VideoBridge, type VideoSource, type VideoState } from '../../modules/video';
import { ScreenPicker, SharingBar, openScreenPicker } from './ScreenPicker';
import { initialPick, moveSelection, rememberShare, rememberedShare, sourcesFor } from './screen-picker';
import { CallVideoButtons } from './CallControls';
import { ShareSound } from './ShareSound';
import { VoiceController, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge } from '../../modules/voice/voice.fake';

const SOURCES: VideoSource[] = [
  { id: 'display:1', name: 'Screen 1 (main)', kind: 'display', width: 3024, height: 1964, main: true, hasSelf: true },
  { id: 'display:2', name: 'Screen 2', kind: 'display', width: 5120, height: 2880 },
  { id: 'window:7', name: 'zsh — Terminal', kind: 'window', app: 'Terminal', title: 'zsh — make netem' },
  { id: 'window:8', name: 'Docs — Safari', kind: 'window', app: 'Safari', title: 'boson.chat — Directory' },
  { id: 'window:9', name: 'Notes — Pages', kind: 'window', app: 'Pages', title: 'Release notes' },
];

describe('the picker logic', () => {
  beforeEach(() => localStorage.clear());

  it('starts on what is shared now, else the remembered display or app, else the main display', () => {
    expect(initialPick(SOURCES, 'window:8', null)).toEqual({ tab: 'windows', id: 'window:8' });
    expect(initialPick(SOURCES, null, null)).toEqual({ tab: 'screens', id: 'display:1' });
    rememberShare(SOURCES[1], 'detail');
    expect(rememberedShare()).toEqual({ kind: 'display', id: 'display:2', app: undefined, mode: 'detail' });
    expect(initialPick(SOURCES, null, rememberedShare())).toEqual({ tab: 'screens', id: 'display:2' });
    // A window that's gone: another window of the same app.
    rememberShare({ ...SOURCES[2], id: 'window:3' }, 'motion');
    expect(initialPick(SOURCES, null, rememberedShare())).toEqual({ tab: 'windows', id: 'window:7' });
  });

  it('filters windows by app or title, and moves the selection with the keys', () => {
    expect(sourcesFor(SOURCES, 'screens').map((s) => s.id)).toEqual(['display:1', 'display:2']);
    expect(sourcesFor(SOURCES, 'windows', 'safari').map((s) => s.id)).toEqual(['window:8']);
    expect(sourcesFor(SOURCES, 'windows', 'release').map((s) => s.id)).toEqual(['window:9']);
    expect(moveSelection(0, 5, 3, 'ArrowRight')).toBe(1);
    expect(moveSelection(1, 5, 3, 'ArrowDown')).toBe(4);
    expect(moveSelection(4, 5, 3, 'ArrowUp')).toBe(1);
    expect(moveSelection(0, 5, 3, 'ArrowLeft')).toBe(0);
    expect(moveSelection(2, 5, 3, 'End')).toBe(4);
    expect(moveSelection(2, 5, 3, 'a')).toBeNull();
  });
});

describe('the screen share picker', () => {
  let state: VideoState;
  let bridge: VideoBridge & { screenThumbnails: ReturnType<typeof vi.fn>; stopThumbnails: ReturnType<typeof vi.fn>; setShareVolume: ReturnType<typeof vi.fn> };
  let push: (s: VideoState) => void;

  beforeEach(async () => {
    localStorage.clear();
    state = { ...EMPTY_VIDEO_STATE, available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: true, canPickScreen: true, canShareAudio: false };
    bridge = {
      state: async () => state, onState: (fn) => { push = fn; return () => {}; },
      subscribe: vi.fn(async () => {}), unsubscribe: vi.fn(async () => {}), cameras: vi.fn(async () => []),
      screenSources: vi.fn(async () => SOURCES),
      setCamera: vi.fn(async () => state), setScreen: vi.fn(async () => state),
      shareScreen: vi.fn(async (_on: boolean, id: string, mode: 'detail' | 'motion', sound?: boolean) => { state = { ...state, screen: { on: true, starting: false, id, mode, name: id, sound: !!sound } }; return state; }),
      setShareVolume: vi.fn(async (trackId: number, percent: number) => { state = { ...state, tracks: state.tracks.map((t) => t.trackId === trackId ? { ...t, volume: percent } : t) }; return state; }),
      switchScreen: vi.fn(async (id: string) => state = { ...state, screen: { ...state.screen, id } }),
      screenThumbnails: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `data:image/jpeg;base64,${id}`]))),
      stopThumbnails: vi.fn(async () => {}),
    };
    class NoSocket { binaryType = ''; readyState = 0; onmessage = null; onclose = null; close() {} send() {} constructor(public url: string) {} }
    setVideoController(new VideoController(bridge, { WebSocket: NoSocket as unknown as typeof WebSocket, raf: () => 0, cancelRaf: () => {} }));
    await new Promise((r) => setTimeout(r, 0));
  });
  afterEach(() => { setVideoController(null); setVoiceController(null); });

  async function opened() {
    render(<ScreenPicker />);
    act(() => openScreenPicker());
    await screen.findByRole('dialog', { name: 'Share your screen' });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2));
  }

  it('shows live thumbnails, warns about the hall of mirrors, and stops the thumbnails when it closes', async () => {
    await opened();
    expect(screen.getByRole('tab', { name: 'SCREENS · 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'WINDOWS · 3' })).toBeTruthy();
    await waitFor(() => expect(bridge.screenThumbnails).toHaveBeenCalledWith(['display:1', 'display:2']));
    await waitFor(() => expect(document.querySelectorAll('.picker-thumb img').length).toBe(2));
    // The main display is chosen, and Boson is on it.
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('Screen 1 (main)');
    expect(screen.getByRole('note').textContent).toContain('Boson is on this screen');
    // No "Share sound" while the app can't.
    expect(screen.queryByRole('switch', { name: 'Share sound' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.stopThumbnails).toHaveBeenCalled();
    const calls = bridge.screenThumbnails.mock.calls.length;
    await new Promise((r) => setTimeout(r, 700));
    expect(bridge.screenThumbnails.mock.calls.length).toBe(calls); // no polling after close
    expect(bridge.shareScreen).not.toHaveBeenCalled();
  });

  it('click selects, arrows move, Enter shares in the chosen mode and remembers it', async () => {
    await opened();
    fireEvent.click(screen.getByRole('option', { name: /Screen 2/ }));
    expect(screen.getByRole('option', { name: /Screen 2/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('note')).toBeNull(); // Boson isn't on screen 2
    fireEvent.keyDown(screen.getByRole('option', { name: /Screen 2/ }), { key: 'ArrowLeft' });
    expect(screen.getByRole('option', { name: /Screen 1/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /Text & detail/ }));
    fireEvent.keyDown(screen.getByRole('option', { name: /Screen 1/ }), { key: 'Enter' });
    await waitFor(() => expect(bridge.shareScreen).toHaveBeenCalledWith(true, 'display:1', 'detail', false));
    expect(rememberedShare()).toMatchObject({ id: 'display:1', mode: 'detail' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('double-click shares a window at once; while sharing, "Switch to this" keeps the track', async () => {
    await opened();
    fireEvent.click(screen.getByRole('tab', { name: 'WINDOWS · 3' }));
    fireEvent.input(screen.getByLabelText('Search windows'), { target: { value: 'safari' } });
    expect(screen.getAllByRole('option').length).toBe(1);
    fireEvent.dblClick(screen.getByRole('option', { name: /Directory/ }));
    await waitFor(() => expect(bridge.shareScreen).toHaveBeenCalledWith(true, 'window:8', 'motion', false));
    act(() => push(state));
    // Change: the picker opens on the current choice; another one switches.
    act(() => openScreenPicker());
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByRole('option', { selected: true }).textContent).toContain('Directory'));
    fireEvent.click(screen.getByRole('tab', { name: 'WINDOWS · 3' }));
    fireEvent.click(screen.getByRole('option', { name: /make netem/ }));
    expect(screen.getByRole('button', { name: 'Switch to this' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to this' }));
    await waitFor(() => expect(bridge.switchScreen).toHaveBeenCalledWith('window:7'));
    expect(bridge.shareScreen).toHaveBeenCalledTimes(1);
  });

  it('the screen button opens the picker; the sharing bar shows what is shared, Change and Stop', async () => {
    const vb = createFakeVoiceBridge({ servers: { 'irc.boson.chat': {} } });
    setVoiceController(new VoiceController(vb, { authUrl: 'https://auth.boson.chat', voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }), pollMs: 60_000, keyTarget: null }));
    await new Promise((r) => setTimeout(r, 0));
    act(() => vb.push({ status: 'connected', host: 'irc.boson.chat', room: 'general', roomName: 'General', participants: [] }));
    render(<><CallVideoButtons withCallToggle={false} /><ScreenPicker /><SharingBar /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Share your screen' }));
    await screen.findByRole('dialog', { name: 'Share your screen' });
    expect(screen.getByText('Share to General')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Share screen' }));
    await waitFor(() => expect(bridge.shareScreen).toHaveBeenCalledWith(true, 'display:1', 'motion', false));
    act(() => push(state));
    await screen.findByText(/You're sharing/);
    expect(screen.getByRole('status').textContent).toContain('display:1 · smooth');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(bridge.setScreen).toHaveBeenCalledWith(false, '');
  });

  it('"Share sound": off for each new share, sent when on, and a change of sound is a new share', async () => {
    state = { ...state, canShareAudio: true };
    act(() => push(state));
    await opened();
    const toggle = screen.getByRole('switch', { name: 'Share sound' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Everything you hear')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Share screen' }));
    await waitFor(() => expect(bridge.shareScreen).toHaveBeenCalledWith(true, 'display:1', 'motion', true));
    act(() => push(state));
    // While sharing with sound: the picker shows it on; turning it off and
    // picking another window is a new share, not a switch.
    act(() => openScreenPicker());
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2));
    expect(screen.getByRole('switch', { name: 'Share sound' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'WINDOWS · 3' }));
    expect(screen.getByText('Only this app’s sound')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Share sound' }));
    fireEvent.click(screen.getByRole('option', { name: /make netem/ }));
    expect(screen.queryByRole('button', { name: 'Switch to this' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Share window' }));
    await waitFor(() => expect(bridge.shareScreen).toHaveBeenLastCalledWith(true, 'window:7', 'motion', false));
    expect(bridge.switchScreen).not.toHaveBeenCalled();
  });

  it('the sharing bar says "with sound"', async () => {
    state = { ...state, screen: { on: true, starting: false, id: 'display:1', name: 'Screen 1', mode: 'detail', sound: true } };
    render(<SharingBar />);
    act(() => push(state));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Screen 1 · detail · with sound'));
  });

  it('viewers: mute a share\'s sound, unmute to where it was, or set its volume', async () => {
    const tr = { trackId: 14, userId: 'usr_ada', name: 'ada', kind: 'screen' as const, self: false, layers: [], sound: true, volume: 100 };
    state = { ...state, tracks: [tr] };
    const { rerender } = render(<ShareSound track={tr} />);
    const range = screen.getByRole('slider', { name: 'ada’s screen volume' }) as HTMLInputElement;
    fireEvent.input(range, { target: { value: '60' } });
    fireEvent.change(range, { target: { value: '60' } });
    expect(bridge.setShareVolume).toHaveBeenLastCalledWith(14, 60);
    rerender(<ShareSound track={{ ...tr, volume: 60 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute ada’s screen' }));
    expect(bridge.setShareVolume).toHaveBeenLastCalledWith(14, 0);
    rerender(<ShareSound track={{ ...tr, volume: 0 }} />);
    const unmute = screen.getByRole('button', { name: 'Unmute ada’s screen' });
    expect(unmute.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(unmute);
    expect(bridge.setShareVolume).toHaveBeenLastCalledWith(14, 60);
    // A share without sound has no control; compact is the button alone.
    rerender(<ShareSound track={{ ...tr, sound: false }} />);
    expect(screen.queryByRole('button', { name: /ada’s screen/ })).toBeNull();
    rerender(<ShareSound track={tr} compact />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('button', { name: 'Mute ada’s screen' })).toBeTruthy();
  });
});
