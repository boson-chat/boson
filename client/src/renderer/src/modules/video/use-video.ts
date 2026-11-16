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
