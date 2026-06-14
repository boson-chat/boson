import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Modal } from '@boson/shared';
import { classifyMessage, type ClassifiedUrl } from './embeds/classify';
import {
  getEmbedSettings, embedKindEnabled, type EmbedSettings,
} from '../../modules/ui/embeds.store';
import { getUnfurl } from '../../shared/unfurl';
import { getSpotify, type SpotifyInfo } from '../../shared/spotify';

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
  // Default to the Electron main-process bridges; undefined on web/tests
  // (website embeds then just open externally instead of showing a card).
  const fetcher = unfurl ?? getUnfurl();
  const spotifyFetcher = spotify ?? getSpotify();
  const settings = getEmbedSettings();
  const all = classifyMessage(text).filter((c) => embedKindEnabled(settings, c.kind));
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  if (all.length === 0) return null;
  const visible = all.filter((c) => !dismissed.has(c.url));
  if (visible.length === 0) return null;
  return (
    <div class="msg-embeds">
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
    <button type="button" class="embed-dismiss" title="Dismiss" aria-label="Dismiss embed" onClick={onDismiss}>×</button>
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
function ImageEmbed({ c, auto, dismissBtn }: { c: ClassifiedUrl; auto: boolean; dismissBtn: preact.ComponentChildren }) {
  const [loaded, setLoaded] = useState(auto);
  const [lightbox, setLightbox] = useState(false);
  return (
    <div class="embed embed-image">
      {dismissBtn}
      {loaded ? (
        <button type="button" class="embed-media-btn" onClick={() => setLightbox(true)} aria-label="Open image">
          <img class="embed-img" src={c.url} alt="" loading="lazy" />
        </button>
      ) : (
        <button type="button" class="embed-chip" onClick={() => setLoaded(true)}>
          <span class="embed-chip-icon">🖼</span> Image · {c.domain} — click to load
        </button>
      )}
      {lightbox && <Lightbox url={c.url} onClose={() => setLightbox(false)} />}
    </div>
  );
}

// Direct video file: click-to-load → inline HTML5 player.
function VideoEmbed({ c, auto, dismissBtn }: { c: ClassifiedUrl; auto: boolean; dismissBtn: preact.ComponentChildren }) {
  const [loaded, setLoaded] = useState(auto);
  return (
    <div class="embed embed-video">
      {dismissBtn}
      {loaded ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video class="embed-video-el" src={c.url} controls preload="metadata" autoPlay={!auto} />
      ) : (
        <button type="button" class="embed-chip" onClick={() => setLoaded(true)}>
          <span class="embed-chip-icon">🎬</span> Video · {c.domain} — click to play
        </button>
      )}
    </div>
  );
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
  // YouTube's player needs a real web origin/referrer or it errors ("Error 153
  // / Video player configuration error"). A packaged Electron app loads from
  // file://, which has none — so only play inline when the page has an http(s)
  // origin (dev, or a custom-scheme build); otherwise open YouTube externally.
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const canInline = origin.startsWith('http://') || origin.startsWith('https://');
  const src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&origin=${encodeURIComponent(origin)}`;

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
        <button type="button" class="embed-chip" onClick={() => setStage('facade')}>
          <span class="embed-chip-icon">▶</span> YouTube · {c.domain} — click to load
        </button>
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
        {stage === 'facade' ? (
          <button
            type="button"
            class="embed-yt-thumb"
            onClick={() => (canInline ? setStage('play') : openExternal(c.url))}
            aria-label={canInline ? 'Play video' : 'Watch on YouTube'}
          >
            <img class="embed-img" src={card?.image ?? thumb} alt="" loading="lazy" />
            <span class="embed-yt-play" aria-hidden="true" />
          </button>
        ) : (
          <iframe
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
// inside Electron. Playback uses the preview MP3s; "Open in Spotify" for the
// full track. Falls back to a minimal card when the bridge is unavailable.
function SpotifyEmbed({
  c, spotify, dismissBtn,
}: { c: ClassifiedUrl; spotify?: SpotifyFn; dismissBtn: preact.ComponentChildren }) {
  const type = c.spotifyType!;
  const [info, setInfo] = useState<SpotifyInfo | null>(null);
  const [loading, setLoading] = useState(!!spotify);
  const [playing, setPlaying] = useState<string | null>(null); // currently-playing preview URL
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
    <div class="embed embed-spotify">
      {dismissBtn}
      <div class="embed-spotify-card">
        {info?.cover
          ? <img class="embed-spotify-cover" src={info.cover} alt="" loading="lazy" />
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
              <button type="button" class="embed-spotify-play" onClick={() => toggle(info.previewUrl)}>
                {playing === info.previewUrl ? '❚❚ Pause' : '▶ Preview'}
              </button>
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
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div class="embed-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <img class="embed-lightbox-img" src={url} alt="" onClick={(e) => e.stopPropagation()} />
      <button type="button" class="embed-lightbox-close" aria-label="Close" onClick={onClose}>×</button>
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
      <button type="button" class="embed-chip embed-chip-file" onClick={() => setConfirming(true)}>
        {exe ? '⚠' : '📄'} {c.ext ? `.${c.ext} ` : ''}file · {c.domain} — download
      </button>
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
            <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
            <button
              type="button"
              class={exe ? 'embed-file-confirm-danger' : 'embed-file-confirm'}
              onClick={() => { openExternal(c.url); setConfirming(false); }}
            >
              Open in browser
            </button>
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
              <img class="embed-card-img" src={card.image} alt="" loading="lazy" />
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
