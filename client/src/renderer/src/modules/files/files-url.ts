// Links to a network's files host: https://files.example.org/f/<id>/<name>
// (id: 22+ characters of base62). Only hosts the shell discovered count,
// so a look-alike link elsewhere stays an ordinary link.

export type FilesMedia = 'image' | 'video' | 'audio' | 'file';

export interface FilesLink {
  url: string;
  origin: string;
  id: string;
  name: string;
  ext: string;
  media: FilesMedia;
}

// What the files service serves inline (and browsers play).
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);
const VIDEO = new Set(['mp4', 'webm']);
const AUDIO = new Set(['mp3', 'ogg', 'wav']);

const PATH = /\/f\/([A-Za-z0-9]{22,})\/([^/]+)$/;

export function mediaFor(name: string): FilesMedia {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  return 'file';
}

export function parseFilesUrl(raw: string, isFilesOrigin: (origin: string) => boolean): FilesLink | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!isFilesOrigin(u.origin.toLowerCase())) return null;
  const m = PATH.exec(u.pathname);
  if (!m) return null;
  let name: string;
  try { name = decodeURIComponent(m[2]!); } catch { return null; }
  const dot = name.lastIndexOf('.');
  return {
    url: raw,
    origin: u.origin.toLowerCase(),
    id: m[1]!,
    name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    media: mediaFor(name),
  };
}
