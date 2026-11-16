import type { VideoCamera, VideoSource, VideoState } from './video.types';

// window.bosonVideo: the app's VideoService (desktop/video.go), installed
// by platform/wails.ts. Absent in a browser.
export interface VideoBridge {
  state(): Promise<VideoState>;
  onState(fn: (s: VideoState) => void): () => void;
  // Receive a track up to `layer` (what fits its tile) / stop.
  subscribe(trackId: number, layer: number): Promise<void>;
  unsubscribe(trackId: number): Promise<void>;
  cameras(): Promise<VideoCamera[]>;
  screenSources(): Promise<VideoSource[]>;
  setCamera(on: boolean, cameraId: string): Promise<VideoState>;
  setScreen(on: boolean, sourceId: string): Promise<VideoState>;
}

export function videoBridge(): VideoBridge | null {
  return (globalThis as { bosonVideo?: VideoBridge }).bosonVideo ?? null;
}
