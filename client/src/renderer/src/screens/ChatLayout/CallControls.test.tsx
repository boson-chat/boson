import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { VoiceController, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../../modules/voice/voice.fake';
import { __resetVoiceSettings } from '../../modules/voice/voice.settings';
import { VideoController, setVideoController, EMPTY_VIDEO_STATE, type VideoBridge, type VideoState } from '../../modules/video';
import { CallStage } from './CallStage';
import { MobileCallScreen } from './MobileCall';
import { CallVideoButtons } from './CallControls';

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

  it('on the call screen (alwaysShow): Camera and Share stay, disabled with the reason', async () => {
    render(<CallVideoButtons alwaysShow withCallToggle={false} />);
    const cam = await screen.findByRole('button', { name: /^Camera unavailable: this voice server/ });
    expect((cam as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^Screen sharing unavailable/ }) as HTMLButtonElement).disabled).toBe(true);
    // Video, but a device that can't share its screen.
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: false });
    await screen.findByRole('button', { name: 'Turn camera on' });
    const share = screen.getByRole('button', { name: 'Screen sharing isn’t available on this device' }) as HTMLButtonElement;
    expect(share.disabled).toBe(true);
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

describe('camera-only builds (iOS)', () => {
  it('show the camera button but not screen sharing', async () => {
    render(<CallVideoButtons />);
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: false });
    await screen.findByRole('button', { name: 'Turn camera on' });
    expect(screen.queryByRole('button', { name: 'Share your screen' })).toBeNull();
  });
});

describe('a camera the system stopped', () => {
  it('shows as paused, not as an error, and a click turns it off', async () => {
    render(<CallVideoButtons />);
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true,
      camera: { on: false, starting: false, paused: true, error: 'The camera stopped: the camera sent no picture for 5s' } });
    const b = await screen.findByRole('button', { name: /Camera paused/ });
    expect(b.getAttribute('data-paused')).not.toBeNull();
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText(/sent no picture/)).toBeNull();
    fireEvent.click(b);
    expect(videoBridge.setCamera).toHaveBeenLastCalledWith(false, '');
  });
});

describe('the call on a phone', () => {
  it('has one dock: mute, camera, flip, more and leave; chat in the header', async () => {
    videoBridge.cameras = vi.fn(async () => [
      { id: 'front', name: 'Front Camera', kind: 'builtin' as const, facing: 'front' as const, default: true },
      { id: 'back', name: 'Back Camera', kind: 'builtin' as const, facing: 'back' as const, default: false },
    ]);
    const onChat = vi.fn();
    render(<MobileCallScreen onChat={onChat} />);
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, canShareScreen: false, tracks: [ALICE_CAM],
      camera: { on: true, starting: false, id: 'front', facing: 'front' } });
    await screen.findByLabelText('alice');
    expect(screen.getAllByRole('button', { name: /leave/i })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Turn camera off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share your screen' })).toBeNull(); // not on phones yet
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to the back camera' }));
    expect(videoBridge.setCamera).toHaveBeenLastCalledWith(true, 'back');
    fireEvent.click(screen.getByRole('button', { name: 'Chat in General' }));
    expect(onChat).toHaveBeenCalled();
    // Our own picture, in a corner, mirrored (front camera).
    expect(screen.getByLabelText('Your video').querySelector('canvas[data-mirror]')).toBeTruthy();
    expect(screen.getByText('you · front')).toBeTruthy();
  });

  it('a paused camera (app was in the background) shows as paused, and a tap turns it off', async () => {
    render(<MobileCallScreen />);
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true,
      camera: { on: false, starting: false, paused: true, error: 'The camera stopped: interrupted' } });
    const b = await screen.findByRole('button', { name: /Camera paused/ });
    expect(b.getAttribute('data-paused')).not.toBeNull();
    fireEvent.click(b);
    expect(videoBridge.setCamera).toHaveBeenLastCalledWith(false, '');
  });

  it('taps the screen share to fill the stage, and again to shrink it', async () => {
    render(<MobileCallScreen />);
    setVideo({ available: true, status: 'connected', tracks: [ALICE_CAM, BOB_SCREEN] });
    fireEvent.click(await screen.findByRole('button', { name: 'Enlarge bob’s screen' }));
    expect(screen.queryByLabelText('alice')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show everyone' }));
    expect(screen.getByLabelText('alice')).toBeTruthy();
  });
});

describe('the self-view', () => {
  it('is mirrored for a front camera or a webcam, never for a back camera', async () => {
    render(<CallStage />);
    const self = () => screen.getByRole('button', { name: 'Focus you' }).querySelector('canvas')!;
    setVideo({ available: true, status: 'connected', canCapture: true, canPublish: true, tracks: [BOB_SCREEN], camera: { on: true, starting: false, facing: 'front' } });
    await screen.findByRole('button', { name: 'Focus you' });
    expect(self().getAttribute('data-mirror')).not.toBeNull();
    setVideo({ camera: { on: true, starting: false, facing: 'back' } });
    expect(self().getAttribute('data-mirror')).toBeNull();
    setVideo({ camera: { on: true, starting: false } }); // a webcam
    expect(self().getAttribute('data-mirror')).not.toBeNull();
  });
});
