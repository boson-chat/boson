import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Button, Modal } from '@boson/shared';
import { X } from 'lucide-preact';
import { classifyMessage, extractUrls, type ClassifiedUrl } from './embeds/classify';
import { getFiles, type FilesLink } from '../../modules/files';
import { FilesEmbed } from './FilesEmbed';
import {
  getEmbedSettings, embedKindEnabled, type EmbedSettings,
} from '../../modules/ui/embeds.store';
import { getUnfurl } from '../../shared/unfurl';
import { getSpotify, type SpotifyInfo } from '../../shared/spotify';
import { CachedImg } from '../../shared/CachedImg';
import { useOffscreen, usePauseOffscreen } from '../../shared/use-offscreen';
import { INLINE_BOX, type ImageKind } from '../../shared/image-cache';

type SpotifyFn = (url: string) => Promise<SpotifyInfo | null>;
import './Embed.css';

// Opens a URL in the OS browser. main's setWindowOpenHandler routes
// target=_blank / window.open to shell.openExternal and denies new windows.
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

// Render an ISO date as a short, human "Feb 20, 2025"; fall back to the raw
// string if it isn't parseable.
function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Optional unfurl fetcher (Phase 3 wires window.bosonUnfurl). When absent,
// website embeds just open externally on click.
export interface OgCard { title?: string; description?: string; image?: string; siteName?: string; author?: string; date?: string; url: string }
export type UnfurlFn = (url: string) => Promise<OgCard | null>;

// All embeds for a message, below its text. Click-to-load by default: chips are
// inert (no network / no remote image) until clicked. Each is dismissible.
export function MessageEmbeds({ text, unfurl, spotify }: { text: string; unfurl?: UnfurlFn; spotify?: SpotifyFn }) {
  // Default to the desktop app's bridges; undefined on web/tests
  // (website embeds then just open externally instead of showing a card).
  const fetcher = unfurl ?? getUnfurl();
  const spotifyFetcher = spotify ?? getSpotify();
  const settings = getEmbedSettings();
  // Links to a network's files host render inline (FilesEmbed); reading
  // origins.value re-renders once a host is discovered.
  const files = getFiles();
  const fileLinks: FilesLink[] = [];
  if (files && files.origins.value.size > 0 && settings.enabled) {
    const seen = new Set<string>();
    for (const u of extractUrls(text)) {
      const l = seen.has(u) ? null : files.parse(u);
      seen.add(u);
      if (l) fileLinks.push(l);
    }
  }
  const fileUrls = new Set(fileLinks.map((l) => l.url));
  const all = classifyMessage(text).filter((c) => !fileUrls.has(c.url) && embedKindEnabled(settings, c.kind));
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [lightbox, setLightbox] = useState<string | null>(null);
  if (all.length === 0 && fileLinks.length === 0) return null;
  const visible = all.filter((c) => !dismissed.has(c.url));
  if (visible.length === 0 && fileLinks.length === 0) return null;
  return (
    <div class="msg-embeds">
      {fileLinks.map((l) => (
        <FilesEmbed key={l.url} link={l} onOpenImage={setLightbox} openExternal={openExternal} />
      ))}
      {lightbox && <Lightbox url={lightbox} kind="file" onClose={() => setLightbox(null)} />}
      {visible.map((c) => (
        <EmbedItem
          key={c.url}
          c={c}
          settings={settings}
          unfurl={fetcher}
          spotify={spotifyFetcher}
          onDismiss={() => setDismissed((prev) => new Set(prev).add(c.url))}
        />
      ))}
    </div>
  );
}

function EmbedItem({
  c, settings, unfurl, spotify, onDismiss,
}: { c: ClassifiedUrl; settings: EmbedSettings; unfurl?: UnfurlFn; spotify?: SpotifyFn; onDismiss: () => void }) {
  const auto = settings.loadMode === 'auto';
  const dismiss = (
    <Button variant="ghost" size="sm" class="embed-dismiss" title="Dismiss" aria-label="Dismiss embed" onClick={onDismiss} icon={<X aria-hidden="true" />} />
  );
  switch (c.kind) {
    case 'image': return <ImageEmbed c={c} auto={auto} dismissBtn={dismiss} />;
    case 'video': return <VideoEmbed c={c} auto={auto} dismissBtn={dismiss} />;
    case 'youtube': return c.youtubeId
      ? <YouTubeEmbed c={c} auto={auto} unfurl={unfurl} dismissBtn={dismiss} />
      : <WebsiteEmbed c={c} settings={settings} unfurl={unfurl} dismissBtn={dismiss} />;
    case 'spotify': return c.spotifyId && c.spotifyType
      ? <SpotifyEmbed c={c} spotify={spotify} dismissBtn={dismiss} />
      : <WebsiteEmbed c={c} settings={settings} unfurl={unfurl} dismissBtn={dismiss} />;
    case 'file': return <FileEmbed c={c} onDismiss={onDismiss} dismissBtn={dismiss} />;
    default: return <WebsiteEmbed c={c} settings={settings} unfurl={unfurl} dismissBtn={dismiss} />;
  }
}

// Image: click-to-load thumbnail → click opens a full-screen in-app lightbox.
// Inline it's the cache's thumbnail (a big image scaled down once, on disk);
// the lightbox loads the full one. Its box is reserved from the size the
// cache reported, so nothing jumps when it lands.
const INLINE_MAX_H = 280;

function ImageEmbed({ c, auto, dismissBtn }: { c: ClassifiedUrl; auto: boolean; dismissBtn: preact.ComponentChildren }) {
  const [loaded, setLoaded] = useState(auto);
  const [lightbox, setLightbox] = useState(false);
  return (
    <div class="embed embed-image">
      {dismissBtn}
      {loaded ? (
        <button type="button" class="embed-media-btn" onClick={() => setLightbox(true)} aria-label="Open image">
          <CachedImg class="embed-img" url={c.url} box={INLINE_BOX} maxHeight={INLINE_MAX_H} loading="lazy" />
        </button>
      ) : (
        <Button variant="secondary" size="sm" class="embed-chip" onClick={() => setLoaded(true)}>
          <span class="embed-chip-icon">🖼</span> Image · {c.domain} — click to load
        </Button>
      )}
      {lightbox && <Lightbox url={c.url} onClose={() => setLightbox(false)} />}
    </div>
  );
}

// Direct video file: click-to-load → inline HTML5 player.
function VideoEmbed({ c, auto, dismissBtn }: { c: ClassifiedUrl; auto: boolean; dismissBtn: preact.ComponentChildren }) {
  const [loaded, setLoaded] = useState(auto);
  const video = useRef<HTMLVideoElement>(null);
  usePauseOffscreen(video);
  return (
    <div class="embed embed-video">
      {dismissBtn}
      {loaded ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video ref={video} class="embed-video-el" src={c.url} controls preload="metadata" autoPlay={!auto} />
      ) : (
        <Button variant="secondary" size="sm" class="embed-chip" onClick={() => setLoaded(true)}>
          <span class="embed-chip-icon">🎬</span> Video · {c.domain} — click to play
        </Button>
      )}
    </div>
  );
}

// In the desktop app the player isn't embedded directly: YouTube refuses to
// play in a wails:// page ("Error 153"), and some videos (label / VEVO
// music) in any local page. The app frames public/youtube-embed.html from
// the origin the shell names (desktop/youtube.go: boson.chat's copy, or its
// e2e build's loopback server), and the wrapper frames YouTube. The wrapper
// posts "ready", and passes on the player's errors (embedding refused, 153).
// An error, or no "ready" in time, turns the player back into the card,
// which opens the video on YouTube. In a browser (`npm run dev`, tests
// without the shell) YouTube is embedded directly.
export const YOUTUBE_WRAPPER_TIMEOUT_MS = 6_000;

export function youtubeWrapperOrigin(): string | null {
  const shell = typeof window !== 'undefined'
    ? (window as { bosonYouTube?: { wrapperOrigin: string | null } }).bosonYouTube
    : undefined;
  return shell?.wrapperOrigin ?? null;
}

// YouTube: a Discord-style card (YouTube label + video title) whose thumbnail
// facade swaps in the privacy-enhanced (youtube-nocookie) iframe on play.
// Nothing hits YouTube until the user clicks past the inert chip.
function YouTubeEmbed({
  c, auto, unfurl, dismissBtn,
}: { c: ClassifiedUrl; auto: boolean; unfurl?: UnfurlFn; dismissBtn: preact.ComponentChildren }) {
  const [stage, setStage] = useState<'chip' | 'facade' | 'play'>(auto ? 'facade' : 'chip');
  const [card, setCard] = useState<OgCard | null>(null);
  const id = c.youtubeId!;
  const thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  // YouTube's player needs a real origin/referrer or it errors ("Error 153 /
  // Video player configuration error"): the desktop app plays it through the
  // wrapper (above), a browser directly; a page with no origin (file://)
  // opens it externally.
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const canInline = !!origin && origin !== 'null' && !origin.startsWith('file:');
  const direct = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&origin=${encodeURIComponent(origin)}`;
  const wrapperOrigin = youtubeWrapperOrigin();
  // YouTube won't play it here: show the card, which opens it on YouTube.
  const [failed, setFailed] = useState(false);
  const src = wrapperOrigin ? `${wrapperOrigin}/youtube-embed.html?v=${encodeURIComponent(id)}` : direct;
  const frame = useRef<HTMLIFrameElement>(null);
  // Scrolled away while playing: the player goes (back to the thumbnail).
  useOffscreen(frame, () => setStage((st) => (st === 'play' ? 'facade' : st)), stage === 'play');

  // Playing through the wrapper: wait for its ready message, else the card.
  // A player error → the card.
  // A layout effect: listening must start before the frame can post. From a
  // loopback server the wrapper reports in ~20 ms after insertion, sooner
  // than useEffect runs (next animation frame, or 100 ms when frames are
  // throttled), and a missed "ready" meant a needless fallback.
  useLayoutEffect(() => {
    if (stage !== 'play' || !wrapperOrigin || failed) return;
    let ready = false;
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== wrapperOrigin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: unknown; v?: unknown } | null;
      if (d?.v !== id) return;
      if (d.type === 'boson-youtube-ready') ready = true;
      if (d.type === 'boson-youtube-error') setFailed(true);
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => { if (!ready) setFailed(true); }, YOUTUBE_WRAPPER_TIMEOUT_MS);
    return () => { window.removeEventListener('message', onMessage); clearTimeout(timer); };
  }, [stage, failed, id, wrapperOrigin]);

  // Once past the inert chip, fetch the video title (OG) for the card header.
  useEffect(() => {
    if (stage === 'chip' || !unfurl) return;
    let alive = true;
    void unfurl(c.url).then((og) => { if (alive && og) setCard(og); }).catch(() => { /* title is optional */ });
    return () => { alive = false; };
  }, [stage, unfurl, c.url]);

  if (stage === 'chip') {
    return (
      <div class="embed embed-youtube">
        {dismissBtn}
        <Button variant="secondary" size="sm" class="embed-chip" onClick={() => setStage('facade')}>
          <span class="embed-chip-icon">▶</span> YouTube · {c.domain} — click to load
        </Button>
      </div>
    );
  }
  return (
    <div class="embed embed-youtube">
      {dismissBtn}
      <div class="embed-card embed-yt-card">
        <span class="embed-card-site">YouTube</span>
        {card?.title && (
          <a class="embed-card-title" href={c.url} target="_blank" rel="noopener noreferrer">{card.title}</a>
        )}
        {(card?.author || card?.date) && (
          <span class="embed-card-meta">
            {card.author}
            {card.author && card.date && <span class="embed-card-dot"> · </span>}
            {card.date && formatDate(card.date)}
          </span>
        )}
        {stage === 'facade' || failed ? (
          <button
            type="button"
            class="embed-yt-thumb"
            onClick={() => (canInline && !failed ? setStage('play') : openExternal(c.url))}
            aria-label={canInline && !failed ? 'Play video' : 'Watch on YouTube'}
            title={failed ? "YouTube won't play this video here. Watch it on YouTube." : undefined}
          >
            <CachedImg class="embed-img" url={card?.image ?? thumb} box={INLINE_BOX} loading="lazy" />
            <span class="embed-yt-play" aria-hidden="true" />
          </button>
        ) : (
          <iframe
            ref={frame}
            class="embed-yt-iframe"
            src={src}
            title="YouTube video player"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
      </div>
    </div>
  );
}

// mm:ss from a millisecond duration.
function fmtDur(ms: number): string {
  if (!ms || ms < 0) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Spotify: a fully custom card built from the embed page's __NEXT_DATA__ (cover,
// title, and — for playlists/albums — the full track list with 30s previews).
// We render our own UI + audio player instead of Spotify's iframe, which crashes
// in a webview. Playback uses the preview MP3s; "Open in Spotify" for the
// full track. Falls back to a minimal card when the bridge is unavailable.
function SpotifyEmbed({
  c, spotify, dismissBtn,
}: { c: ClassifiedUrl; spotify?: SpotifyFn; dismissBtn: preact.ComponentChildren }) {
  const type = c.spotifyType!;
  const [info, setInfo] = useState<SpotifyInfo | null>(null);
  const [loading, setLoading] = useState(!!spotify);
  const [playing, setPlaying] = useState<string | null>(null); // currently-playing preview URL
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useOffscreen(cardRef, () => { if (audioRef.current && !audioRef.current.paused) { audioRef.current.pause(); setPlaying(null); } }, playing !== null);

  useEffect(() => {
    if (!spotify) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    spotify(c.url)
      .then((d) => { if (alive) { setInfo(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [spotify, c.url]);

  // Stop playback when the embed unmounts.
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const toggle = (url?: string): void => {
    const a = audioRef.current;
    if (!url || !a) return;
    if (playing === url) { a.pause(); setPlaying(null); return; }
    a.src = url;
    a.currentTime = 0;
    void a.play().then(() => setPlaying(url)).catch(() => setPlaying(null));
  };

  const label = type === 'track' ? 'Song' : type.charAt(0).toUpperCase() + type.slice(1);
  const title = info?.title ?? (loading ? 'Loading…' : `Spotify ${label}`);
  const sub = info?.subtitle ?? (type === 'track' ? '' : '');
  const tracks = info?.tracks ?? [];

  return (
    <div class="embed embed-spotify" ref={cardRef}>
      {dismissBtn}
      <div class="embed-spotify-card">
        {info?.cover
          ? <CachedImg class="embed-spotify-cover" url={info.cover} box={{ w: 256, h: 256 }} loading="lazy" />
          : <div class="embed-spotify-cover embed-spotify-cover-fallback"><SpotifyIcon /></div>}
        <div class="embed-spotify-info">
          <span class="embed-spotify-brand"><SpotifyIcon /> Spotify · {label}</span>
          <span class="embed-spotify-title">{title}</span>
          {(sub || tracks.length > 0) && (
            <span class="embed-spotify-sub">
              {sub}{sub && tracks.length > 0 ? ' · ' : ''}{tracks.length > 0 ? `${tracks.length} songs` : ''}
            </span>
          )}
          <div class="embed-spotify-actions">
            {info?.previewUrl && (
              <Button variant="secondary" size="sm" class="embed-spotify-play" onClick={() => toggle(info.previewUrl)}>
                {playing === info.previewUrl ? '❚❚ Pause' : '▶ Preview'}
              </Button>
            )}
            <a class="embed-spotify-open" href={c.url} target="_blank" rel="noopener noreferrer">Open in Spotify ↗</a>
          </div>
        </div>
      </div>

      {tracks.length > 0 && (
        <ol class="embed-spotify-tracks">
          {tracks.map((t, i) => {
            const isPlaying = !!t.previewUrl && playing === t.previewUrl;
            return (
              <li key={i} class={`embed-spotify-track${isPlaying ? ' is-playing' : ''}`}>
                <button
                  type="button"
                  class="embed-spotify-trackbtn"
                  disabled={!t.previewUrl}
                  aria-label={t.previewUrl ? (isPlaying ? `Pause ${t.title}` : `Play ${t.title}`) : t.title}
                  onClick={() => toggle(t.previewUrl)}
                >
                  <span class="t-index">{i + 1}</span>
                  {t.previewUrl && <span class="t-icon">{isPlaying ? '❚❚' : '▶'}</span>}
                </button>
                <span class="t-title">{t.title}</span>
                <span class="t-artist">{t.artist}</span>
                <span class="t-dur">{fmtDur(t.durationMs)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} onEnded={() => setPlaying(null)} hidden />
    </div>
  );
}

// Spotify wordmark glyph (SVG so it's OS-independent + on-brand green).
function SpotifyIcon() {
  return (
    <svg class="embed-chip-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#1ed760" />
      <path
        d="M17.6 10.8c-3-1.8-8-2-10.9-1.1a.9.9 0 1 1-.5-1.7c3.3-1 8.8-.8 12.3 1.3a.9.9 0 0 1-.9 1.5zm-.1 2.7c-.3.4-.8.6-1.2.3-2.5-1.5-6.3-2-9.3-1.1a.75.75 0 1 1-.4-1.4c3.4-1 7.6-.5 10.5 1.3.4.2.5.7.4 1zm-1.2 2.6c-.2.3-.6.4-.9.2-2.2-1.3-4.9-1.6-8.1-.9a.6.6 0 1 1-.3-1.2c3.5-.8 6.5-.4 9 1.1.3.2.4.5.3.8z"
        fill="#000"
      />
    </svg>
  );
}

// Full-screen image viewer, portaled to <body>; close on backdrop click / Esc.
// The full image, from the cache (inline previews are thumbnails).
function Lightbox({ url, kind = 'web', onClose }: { url: string; kind?: ImageKind; onClose: () => void }) {
  // Layout effect, not a passive one: Preact defers passive effects to the
  // next animation frame, so an Escape pressed right after the lightbox
  // appears would otherwise land before the listener exists and be lost.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div class="embed-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <span onClick={(e) => e.stopPropagation()} class="embed-lightbox-frame">
        <CachedImg class="embed-lightbox-img" url={url} kind={kind} />
      </span>
      <Button variant="secondary" size="lg" class="embed-lightbox-close" aria-label="Close" onClick={onClose} icon={<X aria-hidden="true" />} />
    </div>,
    document.body,
  );
}

function FileEmbed({ c, dismissBtn }: { c: ClassifiedUrl; onDismiss: () => void; dismissBtn: preact.ComponentChildren }) {
  const [confirming, setConfirming] = useState(false);
  const exe = c.executable;
  return (
    <div class={`embed embed-file ${exe ? 'embed-file-danger' : ''}`}>
      {dismissBtn}
      <Button variant="secondary" size="sm" tone={exe ? 'danger' : undefined} class="embed-chip embed-chip-file" onClick={() => setConfirming(true)}>
        {exe ? '⚠' : '📄'} {c.ext ? `.${c.ext} ` : ''}file · {c.domain} — download
      </Button>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={exe ? 'Download an executable?' : 'Download a file?'}
      >
        <div class="embed-file-warn">
          <p>You're about to open a file from <strong>{c.domain}</strong>:</p>
          <code class="embed-file-url">{c.url}</code>
          {exe && (
            <p class="embed-file-danger-text">
              ⚠ This is an executable / installer. Running files from people you don't fully
              trust can harm your computer or steal your data. Only continue if you're sure.
            </p>
          )}
          <div class="embed-file-actions">
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant={exe ? 'danger' : 'primary'}
              class={exe ? 'embed-file-confirm-danger' : 'embed-file-confirm'}
              onClick={() => { openExternal(c.url); setConfirming(false); }}
            >
              Open in browser
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function WebsiteEmbed({
  c, settings, unfurl, dismissBtn,
}: { c: ClassifiedUrl; settings: EmbedSettings; unfurl?: UnfurlFn; dismissBtn: preact.ComponentChildren }) {
  const [state, setState] = useState<{ phase: 'idle' | 'loading' | 'done' | 'error'; card?: OgCard }>(
    { phase: 'idle' },
  );

  const load = (): void => {
    if (!unfurl) { openExternal(c.url); return; } // no fetcher → just open
    setState({ phase: 'loading' });
    void unfurl(c.url)
      .then((card) => setState(card ? { phase: 'done', card } : { phase: 'error' }))
      .catch(() => setState({ phase: 'error' }));
  };

  // Auto mode: unfurl once on mount.
  useEffect(() => {
    if (settings.loadMode === 'auto' && unfurl) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.phase === 'done' && state.card) {
    const card = state.card;
    return (
      <div class="embed embed-website">
        {dismissBtn}
        <div class="embed-card">
          <span class="embed-card-site">{card.siteName ?? c.domain}</span>
          {card.title && (
            <a class="embed-card-title" href={c.url} target="_blank" rel="noopener noreferrer">{card.title}</a>
          )}
          {card.description && <span class="embed-card-desc">{card.description}</span>}
          {card.image && (
            <a class="embed-card-media" href={c.url} target="_blank" rel="noopener noreferrer" aria-label={card.title ?? c.domain}>
              <CachedImg class="embed-card-img" url={card.image} box={INLINE_BOX} loading="lazy" />
            </a>
          )}
        </div>
      </div>
    );
  }

  const hint = state.phase === 'loading' ? 'Loading preview…'
    : state.phase === 'error' ? 'Preview unavailable — open in browser'
    : unfurl ? 'Click to load preview' : 'Open in browser';
  return (
    <div class="embed embed-website">
      {dismissBtn}
      <button type="button" class="embed-linkcard" onClick={load} disabled={state.phase === 'loading'}>
        <span class="embed-linkcard-icon" aria-hidden="true">{state.phase === 'loading' ? '⏳' : '🔗'}</span>
        <span class="embed-linkcard-body">
          <span class="embed-linkcard-domain">{c.domain}</span>
          <span class="embed-linkcard-hint">{hint}</span>
        </span>
        <span class="embed-linkcard-arrow" aria-hidden="true">↗</span>
      </button>
    </div>
  );
}
