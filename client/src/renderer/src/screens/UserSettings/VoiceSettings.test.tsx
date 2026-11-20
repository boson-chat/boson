import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { VoiceController, getVoiceSettings, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../../modules/voice/voice.fake';
import { __resetVoiceSettings } from '../../modules/voice/voice.settings';
import { VoiceSettingsSection } from './VoiceSettings';
import { VideoController, setVideoController, EMPTY_VIDEO_STATE, type VideoState } from '../../modules/video';

let bridge: FakeVoiceBridge;

describe('Settings → Voice', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetVoiceSettings();
    bridge = createFakeVoiceBridge();
    setVoiceController(new VoiceController(bridge, {
      authUrl: 'https://auth.boson.chat', voiceToken: async () => ({ token: 't', expiresAt: 0 }), keyTarget: null,
    }));
  });
  afterEach(() => setVoiceController(null));

  it('on a phone: no device pickers, and push to talk is the call screen button', async () => {
    window.bosonPlatform = 'ios';
    try {
      render(<VoiceSettingsSection open />);
      expect(screen.queryByLabelText('Input device')).toBeNull();
      expect(screen.getByText(/Your phone cancels echo/)).toBeTruthy();
      fireEvent.click(screen.getByRole('radio', { name: 'Push to talk' }));
      expect(getVoiceSettings().mode).toBe('ptt');
      expect(await screen.findByText(/Hold the talk button while you speak/)).toBeTruthy();
      expect(screen.queryByText('Choose a key')).toBeNull();
      expect(screen.getByRole('radio', { name: 'Open mic' })).toBeTruthy();
    } finally {
      delete window.bosonPlatform;
    }
  });

  it('lists devices and saves the choice', async () => {
    render(<VoiceSettingsSection open />);
    await screen.findByText('Shure MV7');
    fireEvent.change(screen.getByLabelText('Input device'), { target: { value: 'mic2' } });
    expect(getVoiceSettings().inputId).toBe('mic2');
    expect(bridge.calls).toContainEqual({ method: 'setDevices', args: ['mic2', ''] });
  });

  it('push to talk: choose a key', async () => {
    render(<VoiceSettingsSection open />);
    fireEvent.click(screen.getByRole('radio', { name: 'Push to talk' }));
    expect(getVoiceSettings().mode).toBe('ptt');
    fireEvent.click(await screen.findByText('Choose a key'));
    expect(screen.getByText('Press a key…')).toBeTruthy();
    fireEvent.keyDown(window, { code: 'F13', key: 'F13' });
    await waitFor(() => expect(getVoiceSettings().pttCode).toBe('F13'));
    expect(screen.getByText('F13')).toBeTruthy();
  });

  it('sensitivity applies on release', async () => {
    render(<VoiceSettingsSection open />);
    const slider = screen.getByLabelText('Voice activity sensitivity (dB)');
    fireEvent.input(slider, { target: { value: '-30' } });
    expect(screen.getByText('Sensitivity: -30 dB')).toBeTruthy();
    expect(getVoiceSettings().vadDb).toBe(-45);
    fireEvent.change(slider, { target: { value: '-30' } });
    expect(getVoiceSettings().vadDb).toBe(-30);
    expect(bridge.calls).toContainEqual({ method: 'setVADThreshold', args: [-30] });
  });

  it('mic test toggles loopback and stops when closed', async () => {
    const { unmount } = render(<VoiceSettingsSection open />);
    fireEvent.click(screen.getByText("Let's check"));
    await screen.findByText('Stop test');
    expect(screen.getByLabelText('Microphone level')).toBeTruthy();
    unmount();
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === 'micTest').map((c) => c.args[0])).toEqual([true, false]));
  });

  it('shows a mic permission problem', async () => {
    bridge.push({ micTestError: "Boson can't use your microphone." });
    render(<VoiceSettingsSection open />);
    expect(await screen.findByText("Couldn't start the mic test")).toBeTruthy();
  });

  it('"Smoother screen shares" is off by default and saved when turned on', async () => {
    render(<VoiceSettingsSection open />);
    expect(getVoiceSettings().screenPacing).toBe(false);
    const toggle = await screen.findByRole('switch', { name: 'Smoother screen shares' }).catch(() => screen.getByLabelText('Smoother screen shares'));
    fireEvent.click(toggle);
    await waitFor(() => expect(getVoiceSettings().screenPacing).toBe(true));
  });

  it('voice quality: sent to the app, and a channel cap is explained', async () => {
    const { rerender } = render(<VoiceSettingsSection open />);
    expect(bridge.calls).toContainEqual({ method: 'setVoiceQuality', args: ['standard'] });
    expect(screen.getByText(/32 kbps\. Clear speech/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Music' }));
    expect(getVoiceSettings().voiceQuality).toBe('music');
    expect(bridge.calls).toContainEqual({ method: 'setVoiceQuality', args: ['music'] });
    expect(screen.getByText(/tuned for music/)).toBeTruthy();
    // In a channel capped at 48 kbps.
    bridge.push({ status: 'connected', maxBitrate: 48000, bitrate: 48000 });
    rerender(<VoiceSettingsSection open />);
    expect(await screen.findByText(/This channel allows 48 kbps/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Standard' }));
    await waitFor(() => expect(screen.queryByText(/This channel allows/)).toBeNull());
  });

  it('camera quality and, on a phone, data saver', async () => {
    const vstate: VideoState = { ...EMPTY_VIDEO_STATE, metered: true };
    setVideoController(new VideoController({
      state: async () => vstate, onState: () => () => {}, subscribe: async () => {}, unsubscribe: async () => {},
      cameras: async () => [], screenSources: async () => [], setCamera: async () => vstate, setScreen: async () => vstate,
    }));
    window.bosonPlatform = 'android';
    try {
      render(<VoiceSettingsSection open />);
      fireEvent.click(screen.getAllByRole('radio', { name: 'High' })[1]);
      expect(getVoiceSettings().cameraQuality).toBe('high');
      // On mobile data with Auto: data saver is on.
      expect(await screen.findByText('On · mobile data')).toBeTruthy();
      expect(screen.getByText(/your camera sends at most 360p/)).toBeTruthy();
      fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
      expect(getVoiceSettings().dataSaver).toBe('off');
      expect(await screen.findByText('Off now')).toBeTruthy();
    } finally {
      delete window.bosonPlatform;
      setVideoController(null);
    }
  });
});
