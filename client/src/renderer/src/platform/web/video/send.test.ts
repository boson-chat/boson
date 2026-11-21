// What the web build says when what it sends doesn't go out: the camera
// with no pictures, a paused track, a mic that's silent or a suspended
// audio context; and which camera it opens when none was picked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selfNotice } from '../../../modules/video/use-video';
import { MIC_QUIET_MS, micProblem } from '../voice/service';
import { bestCamera, cameraRank } from './layers';
import { NO_PICTURE_MS, WebVideoService } from './service';

const cam = (label: string, deviceId = label) => ({ deviceId, label });

describe('the default camera', () => {
  it('prefers built-in, then external, then an iPhone, then virtual cameras', () => {
    expect(cameraRank('builtin')).toBeLessThan(cameraRank('external'));
    expect(cameraRank('external')).toBeLessThan(cameraRank('continuity'));
    expect(cameraRank('continuity')).toBeLessThan(cameraRank('virtual'));
    expect(bestCamera([cam('OBS Virtual Camera'), cam('iPhone Camera'), cam('FaceTime HD Camera')])?.label).toBe('FaceTime HD Camera');
    expect(bestCamera([cam('OBS Virtual Camera'), cam('Logitech MX Brio')])?.label).toBe('Logitech MX Brio');
    expect(bestCamera([cam('Immersed Webcam'), cam('iPhone Camera')])?.label).toBe('iPhone Camera');
  });

  it('keeps the first of equals and knows nothing before labels are shown', () => {
    expect(bestCamera([cam('USB Camera A'), cam('USB Camera B')])?.label).toBe('USB Camera A');
    expect(bestCamera([cam('', 'a'), cam('', 'b')])).toBeNull();
    expect(bestCamera([])).toBeNull();
  });
});

describe('the mic problem on our tile', () => {
  const ok = { micLevel: 0.3, transmitting: true, speaking: new Map(), lossPercent: 0, audioRunning: true, captureIdleMs: 20, silentMs: 20, micName: 'MacBook Pro Microphone' };

  it('is nothing while the mic gives sound, or while muted', () => {
    expect(micProblem(ok, false)).toBeUndefined();
    expect(micProblem({ ...ok, audioRunning: false }, true)).toBeUndefined();
    expect(micProblem(null, false)).toBeUndefined();
  });

  it('says the browser paused the sound (a context made without a gesture)', () => {
    expect(micProblem({ ...ok, audioRunning: false }, false)).toMatch(/click anywhere/);
  });

  it('names a mic that gives no frames, digital silence or was paused', () => {
    expect(micProblem({ ...ok, captureIdleMs: MIC_QUIET_MS + 1 }, false)).toBe('No sound is coming from your microphone (MacBook Pro Microphone).');
    expect(micProblem({ ...ok, silentMs: MIC_QUIET_MS * 2 + 1 }, false)).toMatch(/MacBook Pro Microphone\) is silent/);
    expect(micProblem({ ...ok, micMuted: true }, false)).toMatch(/paused by the system/);
  });
});

describe('the self-view notice', () => {
  it('is nothing while pictures arrive', () => {
    expect(selfNotice(undefined, 10_000, 20_000, 10_500)).toBeNull();
  });

  it('says the camera is starting, then that no picture came', () => {
    expect(selfNotice(undefined, 0, 1000, 1000)).toBe('Starting your camera…');
    expect(selfNotice(undefined, 0, 7000, 7000)).toBe('No picture from your camera yet…');
    expect(selfNotice(undefined, 1000, 20_000, 9000)).toBe('No picture from your camera yet…');
  });

  it('shows why our video isn’t going out first', () => {
    expect(selfNotice('Your camera isn’t going out: the video encoder failed.', 10_000, 20_000, 10_500)).toMatch(/encoder failed/);
  });
});

describe('a camera that sends no pictures', () => {
  afterEach(() => vi.useRealTimers());

  function service(): WebVideoService {
    return new WebVideoService({ dev: false, voice: { avOffsets: () => new Map(), setAudioDelay: () => {} }, canSend: true, canWatch: true });
  }

  // A camera that's out (published) with a track and a publication.
  function sending(svc: WebVideoService, captured: number, muted = false, since = Date.now()): void {
    const track = { muted, readyState: 'live', stop: () => {} };
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
    Object.assign(svc as unknown as Record<string, unknown>, {
      camera: { on: true, starting: false, id: '', gen: 1, name: 'FaceTime HD Camera', stream, pub: { captured, failure: '', stop: () => {} }, since },
    });
  }

  it('says so on its tile once it has captured nothing for a while', () => {
    vi.useFakeTimers();
    const svc = service();
    sending(svc, 0);
    expect(svc.snapshot().camera.error).toBeUndefined();
    vi.advanceTimersByTime(NO_PICTURE_MS + 200);
    const st = svc.snapshot();
    expect(st.camera.on).toBe(true);
    expect(st.camera.error).toMatch(/FaceTime HD Camera\) isn't giving any pictures/);
    svc.dispose();
  });

  it('pushes the notice to the call view, and drops it once pictures come', () => {
    vi.useFakeTimers();
    const svc = service();
    const seen: Array<string | undefined> = [];
    svc.onState((s) => seen.push(s.camera.error));
    sending(svc, 0);
    vi.advanceTimersByTime(NO_PICTURE_MS + 200);
    expect(seen.at(-1)).toMatch(/isn't giving any pictures/);
    sending(svc, 12, false, Date.now() - NO_PICTURE_MS - 1000);
    vi.advanceTimersByTime(200);
    expect(seen.at(-1)).toBeUndefined();
    svc.dispose();
  });

  it('says when the system paused the camera', () => {
    const svc = service();
    sending(svc, 30, true);
    expect(svc.snapshot().camera.error).toMatch(/paused by the system/);
    svc.dispose();
  });

  it('is quiet for a camera sending pictures', () => {
    const svc = service();
    sending(svc, 30, false, Date.now() - 60_000);
    expect(svc.snapshot().camera.error).toBeUndefined();
    svc.dispose();
  });
});
