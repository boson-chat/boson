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
  // Turn a camera the system stopped back on (a no-op otherwise). Optional:
  // older shells don't have it.
  resumeCamera?(): Promise<VideoState>;
  // The pre-join camera preview (optional: older shells don't have it).
  previewCamera?(on: boolean, cameraId: string): Promise<VideoState>;
  // The screen share picker (optional: older shells don't have them).
  shareScreen?(on: boolean, sourceId: string, mode: 'detail' | 'motion', sound?: boolean): Promise<VideoState>;
  // How loud a screen share's sound is for us (percent, 0 = muted).
  setShareVolume?(trackId: number, percent: number): Promise<VideoState>;
  switchScreen?(sourceId: string): Promise<VideoState>;
  screenThumbnails?(ids: string[]): Promise<Record<string, string>>;
  stopThumbnails?(): Promise<void>;
  // What the camera sends: auto | saver | high (the renderer passes saver
  // while data saver is on). Restarts a running camera. Optional.
  setCameraQuality?(quality: string): Promise<VideoState>;
}

export function videoBridge(): VideoBridge | null {
  return (globalThis as { bosonVideo?: VideoBridge }).bosonVideo ?? null;
}
