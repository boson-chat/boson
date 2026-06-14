// Classify the URLs found in a chat message so the renderer knows what kind of
// click-to-load embed to offer. Pure + dependency-free.

export type EmbedKind = 'image' | 'video' | 'youtube' | 'spotify' | 'file' | 'website';

// Spotify entity types that have an official embed player.
export type SpotifyType = 'track' | 'album' | 'playlist' | 'artist' | 'episode' | 'show';

export interface ClassifiedUrl {
  url: string;
  kind: EmbedKind;
  domain: string;        // hostname without a leading www.
  youtubeId?: string;    // set when kind === 'youtube'
  spotifyType?: SpotifyType; // set when kind === 'spotify'
  spotifyId?: string;    // set when kind === 'spotify'
  ext?: string;          // file extension (lowercase, no dot) for image/video/file
  executable?: boolean;  // true when a file's extension is run-on-open risky
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']);
// Browser-playable video containers → inline <video>. (mkv/avi aren't reliably
// playable in Chromium, so they stay as a download below.)
const VIDEO_EXT = new Set(['mp4', 'webm', 'm4v', 'mov', 'ogv']);
// Non-image/-video extensions we treat as a downloadable file (guarded link).
const FILE_EXT = new Set([
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'rtf', 'csv',
  'mp3', 'wav', 'flac', 'ogg', 'mkv', 'avi',
  'iso', 'img', 'bin', 'deb', 'rpm', 'pkg',
  'exe', 'msi', 'bat', 'cmd', 'sh', 'ps1', 'scr', 'jar', 'dmg', 'apk', 'com', 'vbs', 'app',
]);
// The dangerous subset — run-on-open / installers — gets a stronger warning.
const EXECUTABLE_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'sh', 'ps1', 'scr', 'jar', 'dmg', 'apk', 'com', 'vbs', 'app', 'deb', 'rpm', 'pkg',
]);

// Same shape as the markdown link matcher, but global so we collect all URLs.
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export function extractUrls(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

const SPOTIFY_TYPES = new Set<SpotifyType>(['track', 'album', 'playlist', 'artist', 'episode', 'show']);

// Parse a Spotify entity ({type, id}) from an open.spotify.com URL, else null.
// Handles optional /intl-xx/ locale segments and /embed/ links.
export function spotifyRef(u: URL): { type: SpotifyType; id: string } | null {
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'open.spotify.com' && host !== 'play.spotify.com') return null;
  const m = /^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?([a-z]+)\/([A-Za-z0-9]+)/.exec(u.pathname);
  if (!m) return null;
  const type = m[1] as SpotifyType;
  if (!SPOTIFY_TYPES.has(type)) return null;
  return { type, id: m[2]! };
}

// Parse a YouTube video id from any of the common URL shapes, else null.
export function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id ?? '') ? id! : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = /^\/(?:shorts|embed|v)\/([\w-]{11})/.exec(u.pathname);
    if (m) return m[1]!;
  }
  return null;
}

export function classifyUrl(raw: string): ClassifiedUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const domain = u.hostname.replace(/^www\./, '');

  const yt = youtubeId(u);
  if (yt) return { url: raw, kind: 'youtube', domain, youtubeId: yt };

  const sp = spotifyRef(u);
  if (sp) return { url: raw, kind: 'spotify', domain, spotifyType: sp.type, spotifyId: sp.id };

  const dot = u.pathname.lastIndexOf('.');
  const ext = dot >= 0 ? u.pathname.slice(dot + 1).toLowerCase() : '';
  if (ext && IMAGE_EXT.has(ext)) return { url: raw, kind: 'image', domain, ext };
  if (ext && VIDEO_EXT.has(ext)) return { url: raw, kind: 'video', domain, ext };
  if (ext && FILE_EXT.has(ext)) {
    return { url: raw, kind: 'file', domain, ext, executable: EXECUTABLE_EXT.has(ext) };
  }
  return { url: raw, kind: 'website', domain };
}

// All embeddable URLs in a message, de-duped by URL, in first-seen order.
export function classifyMessage(text: string): ClassifiedUrl[] {
  const out: ClassifiedUrl[] = [];
  const seen = new Set<string>();
  for (const raw of extractUrls(text)) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const c = classifyUrl(raw);
    if (c) out.push(c);
  }
  return out;
}
