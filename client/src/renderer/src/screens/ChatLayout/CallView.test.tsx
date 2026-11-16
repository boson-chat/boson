import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { VoiceController, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../../modules/voice/voice.fake';
import { __resetVoiceSettings } from '../../modules/voice/voice.settings';
import { VideoController, setVideoController, EMPTY_VIDEO_STATE, type VideoBridge, type VideoState } from '../../modules/video';
import { CallView } from './CallView';
import { CallVideoButtons } from './CallControls';
import { MobileCallBar } from './MobileVoice';

const PEOPLE = [
  { sessionId: 1, userId: 'usr_me', name: 'me', self: true, muted: false, deafened: false, speaking: false, volume: 100, listener: false },
  { sessionId: 3, userId: 'usr_alice', name: 'alice', self: false, muted: false, deafened: false, speaking: true, volume: 100, listener: false },
  { sessionId: 4, userId: 'usr_bob', name: 'bob', self: false, muted: true, deafened: false, speaking: false, volume: 100, listener: false },
];

const ALICE_CAM = { trackId: 10, userId: 'usr_alice', name: 'alice', kind: 'camera' as const, self: false, layers: [{ id: 0, width: 640, height: 360, fps: 30 }] };
const BOB_SCREEN = { trackId: 11, userId: 'usr_bob', name: 'bob', kind: 'screen' as const, self: false, layers: [{ id: 0, width: 1920, height: 1080, fps: 15 }] };

let voiceBridge: FakeVoiceBridge;
let videoState: VideoState;
let pushVideo: (s: VideoState) => void;
let videoBridge: VideoBridge;

function setVideo(patch: Partial<VideoState>) {
  videoState = { ...videoState, ...patch };
  act(() => pushVideo(videoState));
}

beforeEach(async () => {
  localStorage.clear();
  __resetVoiceSettings();
  voiceBridge = createFakeVoiceBridge({ servers: { 'irc.boson.chat': {} } });
  setVoiceController(new VoiceController(voiceBridge, {
    authUrl: 'https://auth.boson.chat', voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }), pollMs: 60_000, keyTarget: null,
  }));
  await new Promise((r) => setTimeout(r, 0)); // the controller's first state() answer
  voiceBridge.push({ status: 'connected', host: 'irc.boson.chat', room: 'general', roomName: 'General', participants: PEOPLE });
  videoState = { ...EMPTY_VIDEO_STATE };
  videoBridge = {
    state: async () => videoState,
    onState: (fn) => { pushVideo = fn; return () => {}; },
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    cameras: vi.fn(async () => [
      { id: 'ft', name: 'FaceTime HD Camera', kind: 'builtin' as const, default: false, unavailable: 'the built-in camera is off while the lid is closed' },
      { id: 'phone', name: 'iPhone Camera', kind: 'continuity' as const, default: true },
    ]),
    screenSources: vi.fn(async () => [
      { id: 'display:1', name: 'Screen 1 (main)', kind: 'display' as const, width: 3024, height: 1964 },
      { id: 'window:7', name: 'Notes — Notes', kind: 'window' as const },
    ]),
    // Like the Go side: the answer already says the camera is starting.
    setCamera: vi.fn(async (on: boolean) => {
      videoState = { ...videoState, camera: { on: false, starting: on } };
      return videoState;
    }),
    setScreen: vi.fn(async () => videoState),
  };
  class NoSocket { binaryType = ''; readyState = 0; onmessage = null; onclose = null; close() {} send() {} constructor(public url: string) {} }
  setVideoController(new VideoController(videoBridge, {
    WebSocket: NoSocket as unknown as typeof WebSocket, raf: () => 0, cancelRaf: () => {},
  }));
  // happy-dom lays nothing out: give the call stage a size.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 700; } });
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  setVideoController(null);
  setVoiceController(null);
});

describe('CallVideoButtons', () => {
  it('shows nothing until the server offers video', async () => {
    const { container } = render(<CallVideoButtons />);
    await waitFor(() => expect(container.querySelector('.call-video-buttons')).toBeNull());
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: true });
    await screen.findByRole('button', { name: 'Turn camera on' });
    expect(screen.getByRole('button', { name: 'Share your screen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show the call' })).toBeTruthy();
  });

  it('turns the camera on, says when it is starting, and cancels', async () => {
    render(<CallVideoButtons />);
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn camera on' }));
    expect(videoBridge.setCamera).toHaveBeenCalledWith(true, '');
    fireEvent.click(await screen.findByRole('button', { name: 'Starting camera… (cancel)' }));
    expect(videoBridge.setCamera).toHaveBeenLastCalledWith(false, '');
  });

  it("watch-only builds show no send buttons; listeners can't send", async () => {
    render(<CallVideoButtons />);
    setVideo({ available: true, status: 'connected', canCapture: false, canPublish: true });
    await screen.findByRole('button', { name: 'Show the call' });
    expect(screen.queryByRole('button', { name: /camera|screen/i })).toBeNull();
    setVideo({ canCapture: true, canPublish: false, canShareScreen: true });
    const btns = await screen.findAllByRole('button', { name: 'Sending video in this channel needs the speak role' }) as HTMLButtonElement[];
    expect(btns).toHaveLength(2);
    expect(btns.every((b) => b.disabled)).toBe(true);
  });

  it('asks which screen or window when there is a choice', async () => {
    render(<CallVideoButtons />);
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Share your screen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Notes — Notes/ }));
    expect(videoBridge.setScreen).toHaveBeenCalledWith(true, 'window:7');
  });

  it("lists cameras and won't pick one that can't work", async () => {
    render(<CallVideoButtons />);
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: true });
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Turn camera on' }));
    const ft = await screen.findByRole('menuitem', { name: /FaceTime HD Camera/ }) as HTMLButtonElement;
    expect(ft.disabled).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: /iPhone Camera/ }));
    expect(videoBridge.setCamera).toHaveBeenCalledWith(true, 'phone');
  });
});

describe('CallView', () => {
  it('shows everyone: cameras, avatars, our self-view, and a screen share big', async () => {
    const { container } = render(<CallView />);
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: true, tracks: [ALICE_CAM, BOB_SCREEN], camera: { on: true, starting: false } });
    await screen.findByLabelText('alice');
    expect(screen.getByLabelText('bob’s screen').getAttribute('data-big')).not.toBeNull();
    expect(screen.getByLabelText('alice').querySelector('canvas')).not.toBeNull();
    expect(screen.getByLabelText('alice').getAttribute('data-speaking')).not.toBeNull();
    expect(screen.getByLabelText('bob').querySelector('.call-tile-avatar')).not.toBeNull(); // audio only
    expect(screen.getByLabelText('me (you)').querySelector('canvas[data-mirror]')).not.toBeNull(); // self-view
    expect(container.querySelectorAll('.call-tile')).toHaveLength(4);
  });

  it('goes back to chat', async () => {
    render(<CallView />);
    setVideo({ available: true, status: 'connected', tracks: [ALICE_CAM] });
    const c = (await import('../../modules/video')).getVideoController()!;
    c.setOpen(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to chat' }));
    expect(c.getSnapshot().open).toBe(false);
  });
});

describe('MobileCallBar', () => {
  it('opens the call view on a server with video', async () => {
    render(<MobileCallBar />);
    expect(screen.queryByRole('button', { name: 'Show the call' })).toBeNull();
    setVideo({ available: true, status: 'connected' });
    fireEvent.click(await screen.findByRole('button', { name: 'Show the call' }));
    const c = (await import('../../modules/video')).getVideoController()!;
    expect(c.getSnapshot().open).toBe(true);
    expect(screen.getByRole('button', { name: 'Back to chat' })).toBeTruthy();
  });
});

describe('camera-only builds (iOS)', () => {
  it('show the camera button but not screen sharing', async () => {
    render(<CallVideoButtons />);
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: false });
    await screen.findByRole('button', { name: 'Turn camera on' });
    expect(screen.queryByRole('button', { name: 'Share your screen' })).toBeNull();
  });
});
