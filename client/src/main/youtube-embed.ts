// The hostname the YouTube embed wrapper is served under. YouTube refuses
// some videos (label / VEVO music videos) when the page around its player
// is a local address, and the renderer lives on http://127.0.0.1:<port>.
// So the renderer frames src/renderer/public/youtube-embed.html from
// http://youtube-embed.invalid:<same port> instead, and Chromium is told to
// resolve that name to 127.0.0.1 (host-resolver-rules, set in index.ts).
// `.invalid` is reserved (RFC 6761): it never resolves on the internet, so
// the mapping can't shadow a real site. Keep in sync with Embed.tsx.
export const YOUTUBE_EMBED_HOST = 'youtube-embed.invalid';

export const youtubeEmbedHostRule = `MAP ${YOUTUBE_EMBED_HOST} 127.0.0.1`;

// The only files the loopback server hands out under that hostname: the
// wrapper and its script, never the app itself (a page on that origin
// isn't the app, and mustn't be able to load it).
const WRAPPER_FILES = new Set(['/youtube-embed.html', '/youtube-embed.js']);

// Hostname of a Host header, lower-cased and without the port.
function hostnameOf(host: string | undefined): string {
  return (host ?? '').replace(/:\d+$/, '').toLowerCase();
}

export function isYoutubeEmbedRequest(host: string | undefined): boolean {
  return hostnameOf(host) === YOUTUBE_EMBED_HOST;
}

// For a request under the wrapper's hostname: may this path be served?
export function youtubeEmbedAllows(path: string): boolean {
  return WRAPPER_FILES.has(path);
}
