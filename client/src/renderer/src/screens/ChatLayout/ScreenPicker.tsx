import { useEffect, useRef, useState } from 'preact/hooks';
import { AlertTriangle, X } from 'lucide-preact';
import { useVideo, type VideoSource } from '../../modules/video';
import { useVoice } from '../../modules/voice';
import { initialPick, moveSelection, rememberedShare, rememberShare, sourcesFor, type PickerTab, type ShareMode } from './screen-picker';
import './ScreenPicker.css';

// The screen share picker (desktop, where the app lists sources itself:
// not Linux, whose system portal picks). Screens and windows as live
// thumbnails; click selects, double-click or Enter shares, Esc cancels;
// "Optimize for" detail or motion; "Share sound" where the app can.

let open = false;
const listeners = new Set<(o: boolean) => void>();

/** Open the picker (from a screen button, or the sharing bar's Change). */
export function openScreenPicker(): void {
  open = true;
  listeners.forEach((fn) => fn(open));
}

function closeScreenPicker(): void {
  open = false;
  listeners.forEach((fn) => fn(open));
}

function usePickerOpen(): boolean {
  const [o, set] = useState(open);
  useEffect(() => {
    listeners.add(set);
    set(open);
    return () => { listeners.delete(set); };
  }, []);
  return o;
}

const THUMB_EVERY_MS = 500;

export function ScreenPicker() {
  const isOpen = usePickerOpen();
  if (!isOpen) return null;
  return <PickerDialog onClose={closeScreenPicker} />;
}

function PickerDialog({ onClose }: { onClose: () => void }) {
  const { video, snap } = useVideo();
  const { snap: vsnap } = useVoice();
  const st = snap.state;
  const sharing = st.screen.on || st.screen.starting ? st.screen : null;
  const [sources, setSources] = useState<VideoSource[] | null>(null);
  const [tab, setTab] = useState<PickerTab>('screens');
  const [pick, setPick] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const remembered = useRef(rememberedShare());
  const [mode, setMode] = useState<ShareMode>(sharing?.mode ?? remembered.current?.mode ?? 'motion');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  // The sources, and where to start: what's shared now, else the last.
  useEffect(() => {
    if (!video) return;
    let alive = true;
    void video.screenSources().then((list) => {
      if (!alive) return;
      setSources(list);
      const first = initialPick(list, sharing?.id ?? null, remembered.current);
      setTab(first.tab);
      setPick(first.id);
    });
    return () => { alive = false; };
  }, [video]);

  const list = sources ? sourcesFor(sources, tab, search) : [];
  const counts = { screens: sources ? sourcesFor(sources, 'screens').length : 0, windows: sources ? sourcesFor(sources, 'windows').length : 0 };

  // Live thumbnails of what's on the tab, while the picker is open; the
  // capture stops when it closes.
  const ids = list.map((s) => s.id).join(',');
  useEffect(() => {
    if (!video || !ids) return;
    let alive = true;
    const poll = () => { void video.screenThumbnails(ids.split(',')).then((t) => { if (alive) setThumbs((prev) => ({ ...prev, ...t })); }); };
    poll();
    const timer = setInterval(poll, THUMB_EVERY_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [video, ids]);
  useEffect(() => () => video?.stopThumbnails(), [video]);

  // Focus follows the selection (roving tabindex).
  useEffect(() => {
    if (pick) optionRefs.current.get(pick)?.focus();
  }, [pick, tab]);

  const chosen = sources?.find((s) => s.id === pick) ?? null;
  const cols = tab === 'screens' ? 2 : 3;
  const share = (id = pick) => {
    const src = sources?.find((s) => s.id === id);
    if (!video || !src) return;
    rememberShare(src, mode);
    if (sharing && sharing.mode === mode && sharing.id !== src.id) void video.switchScreen(src.id);
    else if (!sharing || sharing.mode !== mode) void video.shareScreen(src.id, mode);
    video.setOpen(true);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement) && pick) { e.preventDefault(); share(); return; }
    if (!(e.target as HTMLElement).closest?.('[role="listbox"]')) return;
    const i = list.findIndex((s) => s.id === pick);
    const next = moveSelection(i, list.length, cols, e.key);
    if (next !== null) { e.preventDefault(); setPick(list[next].id); }
  };
  const isScreen = chosen?.kind !== 'window';
  const where = vsnap.call.roomName || vsnap.call.room || 'the call';

  return (
    <div class="picker-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="picker" role="dialog" aria-modal="true" aria-label="Share your screen" ref={dialog} onKeyDown={onKey}>
        <div class="picker-head">
          <span class="picker-title">Share to {where}</span>
          <button type="button" class="picker-icon" aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </div>
        <div class="picker-tabs-row">
          <div role="tablist" class="picker-tabs">
            {(['screens', 'windows'] as const).map((t) => (
              <button key={t} type="button" role="tab" class="picker-tab" aria-selected={tab === t}
                onClick={() => { setTab(t); const first = sources ? sourcesFor(sources, t, search)[0] : undefined; if (first && chosen?.kind !== (t === 'windows' ? 'window' : 'display')) setPick(first.id); }}>
                {t === 'screens' ? 'SCREENS' : 'WINDOWS'} · {counts[t]}
              </button>
            ))}
          </div>
          <span class="picker-spacer" />
          {tab === 'windows' && (
            <>
              <label class="picker-sr" for="picker-search">Search windows</label>
              <input id="picker-search" class="picker-search" placeholder="Search windows" value={search}
                onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
            </>
          )}
        </div>
        <div class="picker-body">
          {sources === null && <div class="picker-empty">Looking for screens and windows…</div>}
          {sources !== null && list.length === 0 && <div class="picker-empty">{search ? 'No windows match.' : tab === 'windows' ? 'No windows to share.' : 'No screens to share.'}</div>}
          <div role="listbox" aria-label="Sources" class="picker-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {list.map((s) => (
              <button key={s.id} type="button" role="option" aria-selected={s.id === pick} tabIndex={s.id === pick ? 0 : -1}
                ref={(el) => { if (el) optionRefs.current.set(s.id, el); else optionRefs.current.delete(s.id); }}
                class="picker-src" onClick={() => setPick(s.id)} onDblClick={() => { setPick(s.id); share(s.id); }}>
                <span class="picker-thumb">
                  {thumbs[s.id] ? <img src={thumbs[s.id]} alt="" /> : <span class="picker-thumb-none" aria-hidden="true" />}
                  {s.kind === 'display' && s.width && s.height && <span class="picker-res">{s.width}×{s.height}</span>}
                </span>
                <span class="picker-label">
                  {s.icon ? <img class="picker-app-icon" src={s.icon} alt="" /> : <span class="picker-app-icon picker-app-glyph" aria-hidden="true">{s.kind === 'display' ? '▭' : (s.app ?? s.name).slice(0, 1).toUpperCase()}</span>}
                  <span class="picker-names">
                    <span class="picker-name">{s.kind === 'window' ? (s.title || s.app || s.name) : s.name}</span>
                    <span class="picker-sub">{s.kind === 'window' ? s.app : s.hasSelf ? 'Boson is here' : s.main ? 'main' : 'display'}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
        {chosen?.kind === 'display' && chosen.hasSelf && (
          <div role="note" class="picker-warn">
            <AlertTriangle size={16} aria-hidden="true" />
            Boson is on this screen, so others will see the call inside your share. Boson's window is hidden from the share automatically.
          </div>
        )}
        <div class="picker-options">
          <div class="picker-opt">
            <span class="picker-opt-title">OPTIMIZE FOR</span>
            <div role="radiogroup" aria-label="Optimize for" class="picker-seg-row">
              <button type="button" role="radio" aria-checked={mode === 'detail'} class="picker-seg" onClick={() => setMode('detail')}>
                <span class="picker-seg-name">Text &amp; detail</span><span class="picker-seg-sub">Sharp, up to 1440p · 15 fps</span>
              </button>
              <button type="button" role="radio" aria-checked={mode === 'motion'} class="picker-seg" onClick={() => setMode('motion')}>
                <span class="picker-seg-name">Smooth motion</span><span class="picker-seg-sub">Video &amp; scrolling · 1080p · 30 fps</span>
              </button>
            </div>
          </div>
          {st.canShareAudio && (
            <div class="picker-opt picker-opt-sound">
              <span class="picker-opt-title">SOUND</span>
              <div class="picker-sound">
                <span class="picker-names"><span class="picker-seg-name">Share sound</span><span class="picker-seg-sub">{isScreen ? 'Everything you hear' : 'Only this app’s sound'}</span></span>
                <button type="button" role="switch" aria-checked={false} aria-label="Share sound" class="picker-switch" disabled />
              </div>
            </div>
          )}
        </div>
        <div class="picker-foot">
          <span class="picker-hint">Double-click to share at once · Enter shares · Esc cancels</span>
          <button type="button" class="picker-btn" onClick={onClose}>Cancel</button>
          <button type="button" class="picker-btn picker-primary" disabled={!chosen} onClick={() => share()}>
            {sharing && sharing.id !== pick && sharing.mode === mode ? 'Switch to this' : isScreen ? 'Share screen' : 'Share window'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** While you share your screen (on the call's stage): what, how, a small
 * live preview, Change (the picker, on your current choice; on Linux the
 * system's picker again) and Stop. */
export function SharingBar() {
  const { video, snap } = useVideo();
  const scr = snap.state.screen;
  const [thumb, setThumb] = useState<string | null>(null);
  // Paused while the picker is open: it has the thumbnails then.
  const pickerOpen = usePickerOpen();
  const id = scr.on && !pickerOpen ? scr.id ?? '' : '';
  useEffect(() => {
    if (!video || !id) return;
    let alive = true;
    const poll = () => { void video.screenThumbnails([id]).then((t) => { if (alive && t[id]) setThumb(t[id]); }); };
    poll();
    const timer = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(timer); video.stopThumbnails(); };
  }, [video, id]);
  if (!video || !scr.on) return null;
  const how = scr.mode === 'detail' ? 'detail' : 'smooth';
  return (
    <div class="sharebar" role="status">
      <span class="sharebar-thumb" aria-label="Preview of what you're sharing">
        {thumb && <img src={thumb} alt="" />}
        <span class="voice-live" aria-hidden="true">LIVE</span>
      </span>
      <span class="sharebar-text">You're sharing <span class="sharebar-what">{scr.name || 'your screen'}</span> · {how}</span>
      <button type="button" class="sharebar-btn" onClick={() => {
        if (snap.state.canPickScreen) openScreenPicker();
        else void video.setScreen(true, '');
      }}>Change</button>
      <button type="button" class="sharebar-btn sharebar-stop" onClick={() => { void video.setScreen(false); }}>Stop</button>
    </div>
  );
}
