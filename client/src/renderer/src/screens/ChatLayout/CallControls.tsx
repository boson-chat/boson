import { useState } from 'preact/hooks';
import { LayoutGrid, MonitorUp, MonitorX, Video, VideoOff } from 'lucide-preact';
import { Button, Menu, MenuItem, type ButtonSize } from '@boson/shared';
import { useVideo, type VideoCamera, type VideoSource } from '../../modules/video';
import './CallView.css';
import { openScreenPicker } from './ScreenPicker';
import { useVoice } from '../../modules/voice';

// Camera, screen share and "show the call" for the voice bar and the call
// view. Nothing renders until the call's voice server offers video.
// size / fullWidth: the dock's 44px buttons, or the voice panel's grid.
// alwaysShow (the call screen's dock): Camera and Share stay, disabled with
// the reason, where they can't be used (no video on this voice server, a
// build that can't send), so they don't just vanish.
export function CallVideoButtons({ withCallToggle = true, size = 'sm', fullWidth = false, alwaysShow = false }: {
  withCallToggle?: boolean; size?: ButtonSize; fullWidth?: boolean; alwaysShow?: boolean;
}) {
  const { video, snap } = useVideo();
  const { snap: vsnap } = useVoice();
  const [menu, setMenu] = useState<'none' | 'camera' | 'screen'>('none');
  const [cams, setCams] = useState<VideoCamera[]>([]);
  const [srcs, setSrcs] = useState<VideoSource[]>([]);
  const st = snap.state;
  if (vsnap.call.status !== 'connected') return null;
  if (!video || !st.available) {
    if (!alwaysShow) return null;
    const why = 'this voice server doesn’t offer video';
    return (
      <span class="call-video-buttons">
        <Button variant="secondary" size={size} fullWidth={fullWidth} class="call-cam-btn" disabled
          aria-label={`Camera unavailable: ${why}`} title={`Camera unavailable: ${why}`} icon={<VideoOff aria-hidden="true" />} />
        <Button variant="secondary" size={size} fullWidth={fullWidth} class="call-screen-btn" disabled
          aria-label={`Screen sharing unavailable: ${why}`} title={`Screen sharing unavailable: ${why}`} icon={<MonitorUp aria-hidden="true" />} />
      </span>
    );
  }
  const canSend = st.canCapture && st.canPublish && !vsnap.call.listener;
  const sendTitle = !st.canCapture
    ? 'This version of the app can’t send video'
    : !st.canPublish || vsnap.call.listener
      ? 'Sending video in this channel needs the speak role'
      : '';

  const shareTitle = canSend ? 'Screen sharing isn’t available on this device' : sendTitle;
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
    // The app's own picker (thumbnails, detail or motion), where it lists
    // the sources itself; Linux's system portal otherwise.
    if (st.canPickScreen) {
      openScreenPicker();
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
      {(st.canCapture || alwaysShow) && (<>
      <Button variant="secondary" size={size} fullWidth={fullWidth} class="call-cam-btn" pressed={camLive} data-paused={cam.paused || undefined}
        data-starting={cam.starting || undefined} disabled={!canSend} aria-label={canSend ? camLabel : sendTitle}
        title={canSend ? camLabel : sendTitle} onClick={toggleCamera} onContextMenu={(e) => { e.preventDefault(); void pickCamera(); }}
        icon={camLive ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />} />
      {(st.canShareScreen || alwaysShow) && (
        <Button variant="secondary" size={size} fullWidth={fullWidth} class="call-screen-btn" pressed={scr.on}
          data-starting={scr.starting || undefined} disabled={!canSend || !st.canShareScreen}
          aria-label={canSend && st.canShareScreen ? scrLabel : shareTitle}
          title={canSend && st.canShareScreen ? scrLabel : shareTitle} onClick={() => { void toggleScreen(); }}
          icon={scr.on || scr.starting ? <MonitorX aria-hidden="true" /> : <MonitorUp aria-hidden="true" />} />
      )}
      </>)}
      {withCallToggle && (
        <Button variant="secondary" size={size} fullWidth={fullWidth} pressed={snap.open}
          aria-label={snap.open ? 'Back to chat' : 'Show the call'} title={snap.open ? 'Back to chat' : 'Show the call'}
          onClick={() => video.setOpen(!snap.open)} icon={<LayoutGrid aria-hidden="true" />} />
      )}
      {((!cam.paused && cam.error) || scr.error) && (
        <span class="call-video-error" role="status">{(!cam.paused && cam.error) || scr.error}</span>
      )}
      {menu === 'screen' && (
        <Menu class="call-menu" label="Share which screen or window?">
          {srcs.map((s) => (
            <MenuItem key={s.id} onClick={() => { setMenu('none'); void video.setScreen(true, s.id); video.setOpen(true); }}>
              {s.name}{s.width ? <span class="call-menu-dim"> {s.width}×{s.height}</span> : null}
            </MenuItem>
          ))}
          <MenuItem onClick={() => setMenu('none')}>Cancel</MenuItem>
        </Menu>
      )}
      {menu === 'camera' && (
        <Menu class="call-menu" label="Which camera?">
          {cams.map((c) => (
            <MenuItem key={c.id} disabled={!!c.unavailable}
              onClick={() => { setMenu('none'); void video.setCamera(true, c.id); video.setOpen(true); }}>
              {c.name}{c.default ? <span class="call-menu-dim"> (default)</span> : null}
              {c.unavailable ? <span class="call-menu-dim"> — {c.unavailable}</span> : null}
            </MenuItem>
          ))}
          <MenuItem onClick={() => setMenu('none')}>Cancel</MenuItem>
        </Menu>
      )}
    </span>
  );
}
