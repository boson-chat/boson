import { useState } from 'preact/hooks';
import { Volume2, VolumeX } from 'lucide-preact';
import { useVideo, type VideoTrack } from '../../modules/video';
import './ShareSound.css';

// A screen share's sound, for viewers: mute it, or turn it up or down
// (for you only, this call). On the share's tile, next to it rather than
// inside (a tile is often a button itself).

// The level to go back to on unmute, per share.
const lastHeard = new Map<number, number>();

export function ShareSound({ track, compact, cls }: { track: VideoTrack; compact?: boolean; cls?: string }) {
  const { video } = useVideo();
  const vol = track.volume ?? 100;
  const [draft, setDraft] = useState<number | null>(null);
  if (!video || !track.sound) return null;
  const shown = draft ?? vol;
  const muted = vol === 0;
  const whose = `${track.name}’s screen`;
  const set = (p: number) => {
    if (p > 0) lastHeard.set(track.trackId, p);
    void video.setShareVolume(track.trackId, p);
  };
  return (
    <div class={cls ? `share-sound ${cls}` : 'share-sound'} data-compact={compact || undefined} data-muted={muted || undefined}>
      <button type="button" class="share-sound-btn" aria-pressed={muted}
        aria-label={muted ? `Unmute ${whose}` : `Mute ${whose}`} title={muted ? 'Unmute its sound' : 'Mute its sound'}
        onClick={() => set(muted ? lastHeard.get(track.trackId) ?? 100 : 0)}>
        {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
      </button>
      {!compact && (
        <input type="range" class="share-sound-range" min={0} max={200} step={5} value={shown}
          aria-label={`${whose} volume`} aria-valuetext={`${shown}%`}
          onInput={(e) => setDraft(Number((e.target as HTMLInputElement).value))}
          onChange={(e) => { set(Number((e.target as HTMLInputElement).value)); setDraft(null); }} />
      )}
    </div>
  );
}
