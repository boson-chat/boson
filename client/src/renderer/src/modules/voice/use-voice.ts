import { useEffect, useState } from 'preact/hooks';
import { getVoiceController, type VoiceController, type VoiceSnapshot } from './voice.controller';
import { IDLE_VOICE_STATE } from './voice.types';

const EMPTY: VoiceSnapshot = { servers: {}, call: IDLE_VOICE_STATE, callServerName: '' };

// The voice controller and its live snapshot; null controller when the app
// has no voice (a browser, iOS/Android).
export function useVoice(): { voice: VoiceController | null; snap: VoiceSnapshot } {
  const voice = getVoiceController();
  const [snap, setSnap] = useState<VoiceSnapshot>(() => voice?.getSnapshot() ?? EMPTY);
  useEffect(() => {
    if (!voice) return;
    setSnap(voice.getSnapshot());
    return voice.subscribe(setSnap);
  }, [voice]);
  return { voice, snap };
}
