import { useState } from 'preact/hooks';
import { LayoutGrid, MonitorUp, MonitorX, Video, VideoOff } from 'lucide-preact';
import { useVideo, type VideoCamera, type VideoSource } from '../../modules/video';
import { useVoice } from '../../modules/voice';

// Camera, screen share and "show the call" for the voice bar and the call
// view. Nothing renders until the call's voice server offers video.
export function CallVideoButtons({ withCallToggle = true }: { withCallToggle?: boolean }) {
  const { video, snap } = useVideo();
  const { snap: vsnap } = useVoice();
  const [menu, setMenu] = useState<'none' | 'camera' | 'screen'>('none');
  const [cams, setCams] = useState<VideoCamera[]>([]);
  const [srcs, setSrcs] = useState<VideoSource[]>([]);
  const st = snap.state;
  if (!video || !st.available || vsnap.call.status !== 'connected') return null;
  const canSend = st.canCapture && st.canPublish && !vsnap.call.listener;
  const sendTitle = !st.canCapture
    ? 'This version of the app can’t send video'
    : !st.canPublish || vsnap.call.listener
      ? 'Sending video in this channel needs the speak role'
      : '';

  const cam = st.camera;
  const scr = st.screen;
  // Paused: stopped by the system (the Mac slept); it comes back on its own.
  const camLive = cam.on || cam.starting || !!cam.paused;
  const camLabel = cam.paused ? 'Camera paused: it comes back when the computer is awake (turn off)'
    : cam.starting ? 'Starting camera… (cancel)' : cam.on ? 'Turn camera off' : 'Turn camera on';
  const scrLabel = scr.starting ? 'Starting screen share… (cancel)' : scr.on ? 'Stop sharing your screen' : 'Share your screen';

  const toggleCamera = () => {
    if (camLive) {
      void video.setCamera(false);
      return;
    }
    void video.setCamera(true);
    video.setOpen(true);
  };
  const toggleScreen = async () => {
    if (scr.on || scr.starting) {
      void video.setScreen(false);
      return;
    }
    const list = await video.screenSources();
    // One choice (the system picker on Linux, one display): just share it.
    if (list.length <= 1) {
      void video.setScreen(true, list[0]?.id ?? '');
      video.setOpen(true);
      return;
    }
    setSrcs(list);
    setMenu('screen');
  };
  const pickCamera = async () => {
    setCams(await video.cameras());
    setMenu(menu === 'camera' ? 'none' : 'camera');
  };

  return (
    <span class="call-video-buttons">
      {/* Builds that can't send (phones for now, Linux release builds)
          watch only: no send buttons. */}
      {st.canCapture && (<>
      <button type="button" class="voice-bar-btn" aria-pressed={camLive} data-live={camLive || undefined} data-paused={cam.paused || undefined}
        data-starting={cam.starting || undefined} disabled={!canSend} aria-label={canSend ? camLabel : sendTitle}
        title={canSend ? camLabel : sendTitle} onClick={toggleCamera} onContextMenu={(e) => { e.preventDefault(); void pickCamera(); }}>
        {camLive ? <Video size={16} aria-hidden="true" /> : <VideoOff size={16} aria-hidden="true" />}
      </button>
      {st.canShareScreen && <button type="button" class="voice-bar-btn" aria-pressed={scr.on} data-live={scr.on || scr.starting || undefined}
        data-starting={scr.starting || undefined} disabled={!canSend} aria-label={canSend ? scrLabel : sendTitle}
        title={canSend ? scrLabel : sendTitle} onClick={() => { void toggleScreen(); }}>
        {scr.on || scr.starting ? <MonitorX size={16} aria-hidden="true" /> : <MonitorUp size={16} aria-hidden="true" />}
      </button>}
      </>)}
      {withCallToggle && (
        <button type="button" class="voice-bar-btn" aria-pressed={snap.open} data-live={snap.open || undefined}
          aria-label={snap.open ? 'Back to chat' : 'Show the call'} title={snap.open ? 'Back to chat' : 'Show the call'}
          onClick={() => video.setOpen(!snap.open)}>
          <LayoutGrid size={16} aria-hidden="true" />
        </button>
      )}
      {((!cam.paused && cam.error) || scr.error) && (
        <span class="call-video-error" role="status">{(!cam.paused && cam.error) || scr.error}</span>
      )}
      {menu === 'screen' && (
        <div class="call-menu" role="menu" aria-label="Share which screen or window?">
          {srcs.map((s) => (
            <button key={s.id} type="button" role="menuitem" class="call-menu-item"
              onClick={() => { setMenu('none'); void video.setScreen(true, s.id); video.setOpen(true); }}>
              {s.name}{s.width ? <span class="call-menu-dim"> {s.width}×{s.height}</span> : null}
            </button>
          ))}
          <button type="button" role="menuitem" class="call-menu-item call-menu-cancel" onClick={() => setMenu('none')}>Cancel</button>
        </div>
      )}
      {menu === 'camera' && (
        <div class="call-menu" role="menu" aria-label="Which camera?">
          {cams.map((c) => (
            <button key={c.id} type="button" role="menuitem" class="call-menu-item" disabled={!!c.unavailable}
              title={c.unavailable} onClick={() => { setMenu('none'); void video.setCamera(true, c.id); video.setOpen(true); }}>
              {c.name}{c.default ? <span class="call-menu-dim"> (default)</span> : null}
              {c.unavailable ? <span class="call-menu-dim"> — {c.unavailable}</span> : null}
            </button>
          ))}
          <button type="button" role="menuitem" class="call-menu-item call-menu-cancel" onClick={() => setMenu('none')}>Cancel</button>
        </div>
      )}
    </span>
  );
}
