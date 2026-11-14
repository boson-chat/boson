import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { VoiceController, getVoiceSettings, setVoiceController } from '../../modules/voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../../modules/voice/voice.fake';
import { __resetVoiceSettings } from '../../modules/voice/voice.settings';
import { VoiceSettingsSection } from './VoiceSettings';

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

  it('lists devices and saves the choice', async () => {
    render(<VoiceSettingsSection open />);
    await screen.findByText('Shure MV7');
    fireEvent.change(screen.getByLabelText('Input device'), { target: { value: 'mic2' } });
    expect(getVoiceSettings().inputId).toBe('mic2');
    expect(bridge.calls).toContainEqual({ method: 'setDevices', args: ['mic2', ''] });
  });

  it('push to talk: choose a key', async () => {
    render(<VoiceSettingsSection open />);
    fireEvent.click(screen.getByRole('tab', { name: 'Push to talk' }));
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
});
