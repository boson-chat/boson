import { describe, it, expect } from 'vitest';
import { parseSpotifyNextData, spotifyEmbedUrl } from './spotify';

describe('spotifyEmbedUrl', () => {
  it('builds the embed URL and rejects non-Spotify / bad paths', () => {
    expect(spotifyEmbedUrl('https://open.spotify.com/track/abc123'))
      .toEqual({ embed: 'https://open.spotify.com/embed/track/abc123', type: 'track' });
    expect(spotifyEmbedUrl('https://open.spotify.com/intl-de/album/xyz')?.embed)
      .toBe('https://open.spotify.com/embed/album/xyz');
    expect(spotifyEmbedUrl('https://open.spotify.com/embed/playlist/pl1')?.type).toBe('playlist');
    expect(spotifyEmbedUrl('https://open.spotify.com/user/someone')).toBeNull(); // not an embeddable entity
    expect(spotifyEmbedUrl('https://evil.example.com/track/abc')).toBeNull();    // SSRF guard
  });
});

describe('parseSpotifyNextData', () => {
  const wrap = (entity: unknown): string =>
    `<html><script id="__NEXT_DATA__" type="application/json">${
      JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })
    }</script></html>`;

  it('parses a track (title, artist, cover, preview)', () => {
    const html = wrap({
      type: 'track',
      title: 'Speak To Me',
      artists: [{ name: 'Pink Floyd' }],
      duration: 234000,
      audioPreview: { url: 'https://p.scdn.co/mp3-preview/abc' },
      visualIdentity: { image: [{ url: 'https://img/64', maxWidth: 64 }, { url: 'https://img/640', maxWidth: 640 }] },
    });
    const info = parseSpotifyNextData(html, 'https://open.spotify.com/track/x')!;
    expect(info.type).toBe('track');
    expect(info.title).toBe('Speak To Me');
    expect(info.subtitle).toBe('Pink Floyd');
    expect(info.cover).toBe('https://img/640'); // largest picked
    expect(info.previewUrl).toBe('https://p.scdn.co/mp3-preview/abc');
  });

  it('parses a playlist with a track list', () => {
    const html = wrap({
      type: 'playlist',
      title: 'Today’s Top Hits',
      subtitle: 'Spotify',
      coverArt: { sources: [{ url: 'https://c/300', width: 300 }, { url: 'https://c/64', width: 64 }] },
      trackList: [
        { title: 'A', subtitle: 'Artist A', duration: 200000, audioPreview: { url: 'https://p/a' } },
        { title: 'B', subtitle: 'Artist B', duration: 180000 },
        { title: '', subtitle: 'skip me' }, // dropped (no title)
      ],
    });
    const info = parseSpotifyNextData(html, 'https://open.spotify.com/playlist/x')!;
    expect(info.cover).toBe('https://c/300');
    expect(info.tracks).toHaveLength(2);
    expect(info.tracks![0]).toEqual({ title: 'A', artist: 'Artist A', durationMs: 200000, previewUrl: 'https://p/a' });
    expect(info.tracks![1]!.previewUrl).toBeUndefined();
  });

  it('returns null without __NEXT_DATA__ or entity', () => {
    expect(parseSpotifyNextData('<html>nope</html>', 'https://open.spotify.com/track/x')).toBeNull();
    expect(parseSpotifyNextData(wrap(null), 'https://open.spotify.com/track/x')).toBeNull();
  });
});
