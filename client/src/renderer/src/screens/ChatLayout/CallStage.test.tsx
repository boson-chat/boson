import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { VoiceController, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../../modules/voice/voice.fake';
import { __resetVoiceSettings } from '../../modules/voice/voice.settings';
import { EMPTY_VIDEO_STATE, VideoController, setVideoController, type VideoBridge, type VideoState } from '../../modules/video';
import { CallStage } from './CallStage';
import { CallPanel } from './CallPanel';
import { InCallStrip } from './InCallStrip';
import { formatClock, gridShape } from './call-shared';
import { setVoiceUi, useVoiceUi } from './VoiceRooms';

const HOST = 'irc.boson.chat';
const crowd = (n: number) => [
  { sessionId: 1, userId: 'usr_me', name: 'me', self: true, muted: false, deafened: false, speaking: false, volume: 100 },
  ...Array.from({ length: n - 1 }, (_, i) => ({
    sessionId: i + 2, userId: `usr_${i}`, name: ['mira', 'kestrel', 'juno'][i] ?? `p${i}`, self: false,
    muted: i === 2, deafened: false, speaking: i === 0, volume: 100,
  })),
];
const KESTREL_SCREEN = { trackId: 11, userId: 'usr_1', name: 'kestrel', kind: 'screen' as const, self: false, layers: [{ id: 0, width: 1920, height: 1080, fps: 15 }] };
const MIRA_CAM = { trackId: 10, userId: 'usr_0', name: 'mira', kind: 'camera' as const, self: false, layers: [{ id: 0, width: 640, height: 360, fps: 30 }] };

let bridge: FakeVoiceBridge;
let vstate: VideoState;

async function setup(n: number, tracks = [KESTREL_SCREEN, MIRA_CAM]) {
  bridge = createFakeVoiceBridge({ servers: { [HOST]: {} } });
  const voice = new VoiceController(bridge, { authUrl: 'https://auth.boson.chat', voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }), pollMs: 60_000, keyTarget: null });
  setVoiceController(voice);
  vstate = { ...EMPTY_VIDEO_STATE, available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: true, tracks };
  const vb: VideoBridge = {
    state: async () => vstate, onState: () => () => {},
    subscribe: vi.fn(async () => {}), unsubscribe: vi.fn(async () => {}), cameras: vi.fn(async () => []), screenSources: vi.fn(async () => []),
    setCamera: vi.fn(async () => vstate), setScreen: vi.fn(async () => vstate),
  };
  class NoSocket { binaryType = ''; readyState = 0; onmessage = null; onclose = null; close() {} send() {} constructor(public url: string) {} }
  setVideoController(new VideoController(vb, { WebSocket: NoSocket as unknown as typeof WebSocket, raf: () => 0, cancelRaf: () => {} }));
  await new Promise((r) => setTimeout(r, 0));
  act(() => bridge.push({ status: 'connected', host: HOST, room: 'general', roomName: 'General', rttMs: 38, participants: crowd(n) }));
}

beforeEach(() => { localStorage.clear(); __resetVoiceSettings(); });
afterEach(() => { setVoiceUi({ view: null }); setVoiceController(null); setVideoController(null); });

describe('call-shared', () => {
  it('formats the call clock and shapes the grid', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(724_000)).toBe('12:04');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(gridShape(4)).toEqual({ cols: 2, rows: 'minmax(0, 1fr)' });
    expect(gridShape(9).cols).toBe(3);
    expect(gridShape(12)).toEqual({ cols: 4, rows: 'minmax(0, 1fr)' });
    expect(gridShape(16)).toEqual({ cols: 4, rows: '200px' });
  });
});

describe('guest badges in the call', () => {
  it('marks guests on the stage and in the people list', async () => {
    await setup(3, []);
    act(() => bridge.push({ participants: [...crowd(3), { sessionId: 9, userId: 'guest:abcdefabcdefabcd', name: 'kit', self: false, muted: false, deafened: false, speaking: false, volume: 100 }] }));
    render(<><CallStage /><CallPanel /></>);
    const tile = await screen.findByLabelText('Focus kit');
    expect(tile.querySelector('.guest-badge')).toBeTruthy();
    expect(screen.getByLabelText('Focus mira').querySelector('.guest-badge')).toBeNull();
    expect(screen.getByLabelText('kit, guest')).toBeTruthy();
  });
});

describe('the call stage (desktop)', () => {
  it('focuses the screen share, puts everyone else in the strip, and pins a clicked tile', async () => {
    await setup(4);
    render(<CallStage />);
    await screen.findByText('General');
    expect(screen.getByText(/4 in call · 38 ms/)).toBeTruthy();
    const big = document.querySelector('.stage-big .stage-tile')!;
    expect(big.getAttribute('aria-label')).toBe('kestrel’s screen');
    expect(document.querySelectorAll('.stage-strip .stage-tile').length).toBe(4); // me, mira, kestrel, juno
    fireEvent.click(screen.getByRole('button', { name: 'Focus mira' }));
    expect(document.querySelector('.stage-big .stage-tile')!.getAttribute('aria-label')).toBe('mira');
    expect(document.querySelector('.stage-big canvas')).toBeTruthy(); // her camera
    // Grid: every tile, 3 columns for 5.
    fireEvent.click(screen.getByRole('button', { name: 'Grid layout' }));
    const grid = document.querySelector('.stage-grid') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    expect(grid.querySelectorAll('.stage-tile').length).toBe(5);
    // A tile in the grid goes back to focus on it.
    fireEvent.click(screen.getByRole('button', { name: 'Focus juno' }));
    expect(document.querySelector('.stage-big .stage-tile')!.getAttribute('aria-label')).toBe('juno');
  });

  it('scrolls a crowd in fixed rows, and tints the dock red for muted and camera off', async () => {
    await setup(16, []);
    render(<CallStage />);
    await screen.findByText('General');
    fireEvent.click(screen.getByRole('button', { name: 'Grid layout' }));
    const grid = document.querySelector('.stage-grid') as HTMLElement;
    expect(grid.style.gridAutoRows).toBe('200px');
    expect(grid.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    expect(screen.getByRole('button', { name: 'Turn camera on' }).hasAttribute('data-off')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unmute' }).hasAttribute('data-off')).toBe(true));
  });
});

describe('the call panel', () => {
  it('lists speakers first, and has CHAT only for a voice channel under a text channel', async () => {
    await setup(4);
    const send = vi.fn();
    const { rerender } = render(<CallPanel chat={null} />);
    await screen.findByText('IN CALL — 4');
    const sections = [...document.querySelectorAll('.callpanel-section')].map((e) => e.textContent);
    expect(sections).toEqual(['SPEAKING', 'IN CALL']);
    expect(document.querySelector('.callpanel-list .callpanel-name')!.textContent).toBe('mira');
    expect(screen.getByLabelText(/kestrel, sharing their screen/)).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'CHAT' })).toBeNull();
    rerender(<CallPanel chat={{ channel: '#dev', messages: [{ id: '1', kind: 'message', from: 'mira', text: 'nice', timestamp: 1 }], onSend: send }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'CHAT' }));
    expect(screen.getByText('nice')).toBeTruthy();
    const input = screen.getByLabelText('Message #dev');
    fireEvent.input(input, { target: { value: 'hello' } });
    fireEvent.submit(input.closest('form')!);
    expect(send).toHaveBeenCalledWith('hello');
  });
});

describe('the in-call strip', () => {
  it('says who is sharing and opens the call', async () => {
    await setup(4);
    let view: unknown = null;
    function Probe() { view = useVoiceUi().view; return null; }
    render(<><InCallStrip /><Probe /></>);
    await screen.findByText('In General');
    expect(screen.getByText(/4 in call · kestrel is sharing their screen/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open call' }));
    expect(view).toEqual({ host: HOST, roomId: 'general', serverName: expect.any(String) });
  });
});
