import { useEffect, useState } from 'preact/hooks';
import { getVideoController, type VideoController, type VideoSnapshot } from './video.controller';
import { EMPTY_VIDEO_STATE } from './video.types';

const EMPTY: VideoSnapshot = { state: EMPTY_VIDEO_STATE, open: false, pinned: 0 };

// The video controller and its live snapshot; null controller when the
// app has no video (a browser, an older shell).
export function useVideo(): { video: VideoController | null; snap: VideoSnapshot } {
  const video = getVideoController();
  const [snap, setSnap] = useState<VideoSnapshot>(() => video?.getSnapshot() ?? EMPTY);
  useEffect(() => {
    if (!video) return;
    setSnap(video.getSnapshot());
    return video.subscribe(setSnap);
  }, [video]);
  return { video, snap };
}

// What a received video tile should say while it has no picture, or null
// when it's playing (or there's no such track). Polled once a second.
export function useTrackNotice(video: VideoController | null, trackId: number | undefined): string | null {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!video || !trackId) {
      setNotice(null);
      return;
    }
    const tick = () => setNotice(trackNotice(video.stats()[trackId]));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [video, trackId]);
  return notice;
}

export function trackNotice(st: { status: string; reason?: string } | undefined): string | null {
  switch (st?.status) {
    case undefined:
    case 'waiting':
      return 'Waiting for the first picture…';
    case 'stalled':
      return 'No picture for a few seconds…';
    case 'error':
      return `Can’t show this video: ${st.reason ?? 'the decoder failed'}`;
    default:
      return null;
  }
}
