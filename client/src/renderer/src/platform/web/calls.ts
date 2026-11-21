// Voice and video calls in the web build: window.bosonVoice and
// window.bosonVideo over WebTransport (quicvoiced and quicvideod /wt).
// Browsers without WebTransport or WebCodecs Opus (Linux WebKit, older
// Safari) still get the voice bridge, reporting audio: false with the
// reason, so voice channels show and say why calls can't start there.
import { QuicVoiceClient } from './quicvoice/client';
import { videoSupport } from './quicvideo/client';
import { VoiceDiscoverer, isLoopbackHost } from './voice/discovery';
import { WebAudioEngine } from './voice/engine';
import { WebVoiceService, type Conn } from './voice/service';
import { WebVideoService } from './video/service';

export interface CallsOptions {
  authBase: string;
  dev: boolean;
  // Dev/e2e: boson.json documents (contents) for hosts without a domain.
  networkJson?: string[];
  // Dev/e2e: where a self-signed server's /v1/info is, by host:port.
  certInfo?: Record<string, string>;
}

export function callsUnavailableMessage(missing: string[]): string {
  if (missing.length === 0) return '';
  return `Calls need a browser with WebTransport and Opus audio (Chrome, Edge or Firefox). This browser is missing: ${missing.join(', ')}.`;
}

export async function installCalls(w: Record<string, unknown>, opts: CallsOptions): Promise<void> {
  const sup = await WebAudioEngine.support();
  const vsup = await videoSupport().catch(() => ({ watch: false, send: false, missing: ['WebTransport'] }));
  const voice = new WebVoiceService({
    authBase: opts.authBase,
    dev: opts.dev,
    discoverer: new VoiceDiscoverer({ dev: opts.dev, overrides: opts.networkJson }),
    engine: () => new WebAudioEngine(),
    dial: async (url, token, o) => (await QuicVoiceClient.connect(url, token, { certHash: o.certHash, clientVersion: 'boson-web' })) as unknown as Conn,
    audioError: callsUnavailableMessage(sup.missing),
  });
  const certHash = async (hostPort: string): Promise<string | undefined> => {
    const infoUrl = opts.certInfo?.[hostPort];
    if (!infoUrl || !isLoopbackHost(hostPort.replace(/:\d+$/, ''))) return undefined;
    try {
      return ((await (await fetch(infoUrl)).json()) as { dev_cert_hash?: string }).dev_cert_hash;
    } catch {
      return undefined;
    }
  };
  const video = new WebVideoService({
    dev: opts.dev,
    voice: { avOffsets: () => voice.avOffsets(), setAudioDelay: (u, ms) => voice.setAudioDelay(u, ms) },
    certHash,
    canSend: vsup.send && typeof navigator.mediaDevices?.getUserMedia === 'function',
    canWatch: vsup.watch,
  });
  voice.video = video;
  const bind = <T extends object>(o: T, names: string[]): Record<string, unknown> =>
    Object.fromEntries(names.map((n) => [n, (o as Record<string, (...a: unknown[]) => unknown>)[n]!.bind(o)]));
  w.bosonVoice = bind(voice, [
    'discover', 'rooms', 'createRoom', 'updateRoom', 'deleteRoom', 'join', 'leave', 'dismissError', 'setMuted',
    'setDeafened', 'setInputMode', 'ptt', 'setVADThreshold', 'setUserVolume', 'devices', 'setDevices', 'micTest',
    'setVoiceQuality', 'state', 'onState',
  ]);
  if (!sup.ok) return; // no calls here: no video either
  w.bosonVideo = {
    ...bind(video, [
      'state', 'onState', 'subscribe', 'unsubscribe', 'cameras', 'screenSources', 'setCamera', 'setScreen',
      'resumeCamera', 'previewCamera', 'shareScreen', 'setShareVolume', 'switchScreen', 'screenThumbnails',
      'stopThumbnails', 'setCameraQuality',
    ]),
    frameSocket: video.frameSocket,
  };
}
