// Video in voice channels: the shapes the app's VideoService
// (desktop/video.go) sends over the bridge. Every voice channel is also a
// video channel where the voice server has video.

export interface VideoLayer {
  id: number;
  width: number;
  height: number;
  fps: number;
}

export interface VideoTrack {
  trackId: number;
  userId: string;
  name: string;
  kind: 'camera' | 'screen';
  // Our own track (shown from the local self-view, never subscribed).
  self: boolean;
  layers: VideoLayer[];
  // A screen share that carries its sound, and how loud it is for us:
  // percent, 0 = muted, 100 = as sent, up to 200.
  sound?: boolean;
  volume?: number;
}

export interface VideoShareState {
  on: boolean;
  starting: boolean;
  // The camera was stopped by the system (the app in the background, the
  // Mac asleep) and comes back by itself when the app is active again.
  paused?: boolean;
  id?: string; // the camera asked for ('' or absent: the default)
  // Which way the running camera faces: 'front' (the user), 'back', or
  // absent (a webcam). Our preview is mirrored unless it's 'back'.
  facing?: 'front' | 'back' | '';
  // A screen share: optimized for text and detail, or smooth motion.
  mode?: 'detail' | 'motion';
  // A screen share that's sending its sound.
  sound?: boolean;
  name?: string;
  error?: string;
}

export interface VideoState {
  // The voice server offers video for this channel; nothing video shows
  // until it does.
  available: boolean;
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error?: string;
  // The loopback WebSocket the call view reads frames from.
  frameUrl?: string;
  // This build can send video / the channel lets us (we can speak).
  canCapture: boolean;
  canPublish: boolean;
  // This build can share the screen too (iOS: camera only, for now).
  canShareScreen: boolean;
  // The app's own picker lists screens and windows (false where the OS
  // has its own, Linux's portal). Absent from older shells.
  canPickScreen?: boolean;
  // "Share sound" with a screen share: this build and OS can capture it
  // (macOS 13+) and the video server relays it.
  canShareAudio?: boolean;
  camera: VideoShareState;
  screen: VideoShareState;
  // The camera shown only to you before joining (the pre-join self-view):
  // nothing is sent. Absent from older shells.
  preview?: VideoShareState;
  tracks: VideoTrack[];
}

export interface VideoCamera {
  id: string;
  name: string;
  kind: 'builtin' | 'external' | 'continuity' | 'virtual';
  facing?: 'front' | 'back' | '';
  default: boolean;
  // Why it can't be used now (a closed laptop's built-in camera).
  unavailable?: string;
}

export interface VideoSource {
  id: string; // display:N | window:N | '' (the system picker)
  name: string;
  kind: 'display' | 'window' | 'picker';
  width?: number;
  height?: number;
  app?: string; // a window's app
  title?: string; // a window's title
  icon?: string; // the app's icon (a data: URL)
  main?: boolean; // the main display
  hasSelf?: boolean; // Boson's window is on this display
}

export const EMPTY_VIDEO_STATE: VideoState = {
  available: false,
  status: 'idle',
  canCapture: false,
  canPublish: false,
  canShareScreen: false,
  camera: { on: false, starting: false },
  screen: { on: false, starting: false },
  tracks: [],
};
