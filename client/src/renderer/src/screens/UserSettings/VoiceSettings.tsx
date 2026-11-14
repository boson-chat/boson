import { useEffect, useState } from 'preact/hooks';
import { Button, Card, Divider, Field, Tabs, WarningBanner } from '@boson/shared';
import {
  VAD_MAX_DB, VAD_MIN_DB, getVoiceSettings, keyLabel, onVoiceSettingsChange, setVoiceSettings, useVoice,
  type VoiceDevices, type VoiceSettings,
} from '../../modules/voice';
import './VoiceSettings.css';

// Settings → Voice: devices, voice activity or push to talk (with its key
// and sensitivity), and a mic test that plays you back to yourself.
export function VoiceSettingsSection({ open }: { open: boolean }) {
  const { voice, snap } = useVoice();
  const [s, setS] = useState<VoiceSettings>(() => getVoiceSettings());
  useEffect(() => onVoiceSettingsChange(setS), []);
  const [devices, setDevices] = useState<VoiceDevices | null>(null);
  const [capturing, setCapturing] = useState(false);
  // Sensitivity follows the slider live; it's applied on release.
  const [vadDraft, setVadDraft] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !voice) return;
    let live = true;
    void voice.devices().then((d) => { if (live) setDevices(d); });
    return () => { live = false; };
  }, [open, voice]);

  // Leave the mic test running only while this screen is open.
  useEffect(() => () => {
    if (voice?.getSnapshot().call.micTest) void voice.micTest(false);
  }, [voice]);
  useEffect(() => {
    if (!open && voice?.getSnapshot().call.micTest) void voice.micTest(false);
  }, [open, voice]);

  // Choosing the push-to-talk key: the next key pressed (Escape cancels).
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') setVoiceSettings({ pttCode: e.code });
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  if (!voice) return null;
  const call = snap.call;
  const vad = vadDraft ?? s.vadDb;
  // Mic level on the same -60…0 dB scale as the threshold.
  const levelDb = call.micLevel > 0 ? -60 + call.micLevel * 60 : VAD_MIN_DB;
  const meterLive = call.micTest || call.status === 'connected';
  const pct = (db: number): number => Math.max(0, Math.min(100, ((db - VAD_MIN_DB) / (0 - VAD_MIN_DB)) * 100));

  return (
    <section class="user-settings-section">
      <div class="user-settings-section-head">
        <h2 class="user-settings-section-title">Voice</h2>
        <p class="user-settings-section-desc">
          Voice channels on servers that have them. Use headphones: Boson doesn't cancel echo yet, so speakers feed your
          own room back to everyone.
        </p>
      </div>
      <div class="user-settings-section-body">
        {call.errorKind === 'mic' && call.error && (
          <WarningBanner tone="danger" title="No microphone access">{call.error}</WarningBanner>
        )}
        {call.micTestError && (
          <WarningBanner tone="danger" title="Couldn't start the mic test">{call.micTestError}</WarningBanner>
        )}
        {devices?.error && (
          <WarningBanner tone="warn" title="Couldn't list audio devices">{devices.error}</WarningBanner>
        )}
        <Card>
          <div class="user-settings-card-body user-settings-form">
            <div class="voice-settings-devices">
              <Field label="Input device">
                <DeviceSelect
                  label="Input device"
                  value={s.inputId}
                  devices={devices?.inputs ?? []}
                  onChange={(id) => setVoiceSettings({ inputId: id })}
                />
              </Field>
              <Field label="Output device">
                <DeviceSelect
                  label="Output device"
                  value={s.outputId}
                  devices={devices?.outputs ?? []}
                  onChange={(id) => setVoiceSettings({ outputId: id })}
                />
              </Field>
            </div>
            <Divider />
            <Field label="Input mode">
              <Tabs
                tabs={[{ id: 'vad', label: 'Voice activity' }, { id: 'ptt', label: 'Push to talk' }]}
                active={s.mode}
                onChange={(id) => setVoiceSettings({ mode: id === 'ptt' ? 'ptt' : 'vad' })}
              />
            </Field>
            {s.mode === 'ptt' ? (
              <Field
                label="Push-to-talk key"
                hint="Hold it to talk while Boson's window is focused. (A system-wide key isn't supported yet.)"
              >
                <div class="voice-settings-key">
                  <kbd class="voice-settings-kbd" data-unset={!s.pttCode || undefined}>
                    {capturing ? 'Press a key…' : keyLabel(s.pttCode)}
                  </kbd>
                  <Button variant="secondary" size="sm" onClick={() => setCapturing(!capturing)}>
                    {capturing ? 'Cancel' : s.pttCode ? 'Change' : 'Choose a key'}
                  </Button>
                  {s.pttCode && !capturing && (
                    <Button variant="ghost" size="sm" onClick={() => setVoiceSettings({ pttCode: null })}>Clear</Button>
                  )}
                </div>
              </Field>
            ) : (
              <Field
                label={`Sensitivity: ${Math.round(vad)} dB`}
                hint="You transmit while your mic is louder than the marker. Test your mic to see where you land."
              >
                <div class="voice-settings-meter" data-live={meterLive || undefined}>
                  <div class="voice-settings-meter-fill" style={{ width: `${meterLive ? pct(levelDb) : 0}%` }}
                    data-over={meterLive && levelDb >= vad ? true : undefined} />
                  <div class="voice-settings-meter-mark" style={{ left: `${pct(vad)}%` }} />
                </div>
                <input
                  type="range"
                  class="voice-range voice-settings-range"
                  min={VAD_MIN_DB}
                  max={VAD_MAX_DB}
                  step={1}
                  value={vad}
                  aria-label="Voice activity sensitivity (dB)"
                  onInput={(e) => setVadDraft(Number((e.target as HTMLInputElement).value))}
                  onChange={(e) => {
                    setVoiceSettings({ vadDb: Number((e.target as HTMLInputElement).value) });
                    setVadDraft(null);
                  }}
                />
              </Field>
            )}
            <Divider />
            <div class="voice-settings-test">
              <div>
                <div class="voice-settings-test-title">Mic test</div>
                <div class="voice-settings-test-desc">
                  {call.micTest ? 'Talk — you should hear yourself as others will.' : 'Hear yourself through the voice codec.'}
                </div>
              </div>
              <Button variant={call.micTest ? 'secondary' : 'primary'} size="sm" onClick={() => { void voice.micTest(!call.micTest); }}>
                {call.micTest ? 'Stop test' : "Let's check"}
              </Button>
            </div>
            {meterLive && (
              <div class="voice-settings-level" aria-label="Microphone level">
                <div class="voice-settings-level-fill" style={{ width: `${pct(levelDb)}%` }} data-tx={call.transmitting || undefined} />
              </div>
            )}
          </div>
        </Card>
        <p class="voice-settings-note">
          Right-click someone in a voice channel to change how loud they are for you.
        </p>
      </div>
    </section>
  );
}

function DeviceSelect({ label, value, devices, onChange }: {
  label: string;
  value: string;
  devices: ReadonlyArray<{ id: string; name: string; isDefault: boolean }>;
  onChange: (id: string) => void;
}) {
  const known = value === '' || devices.some((d) => d.id === value);
  return (
    <select
      class="bds-input bds-input-sm voice-settings-select"
      aria-label={label}
      value={value}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
    >
      <option value="">System default</option>
      {devices.map((d) => (
        <option key={d.id} value={d.id}>{d.name}{d.isDefault ? ' (default)' : ''}</option>
      ))}
      {!known && <option value={value}>Unavailable device</option>}
    </select>
  );
}
