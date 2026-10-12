// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isYoutubeEmbedRequest, youtubeEmbedAllows, youtubeEmbedHostRule, YOUTUBE_EMBED_HOST } from './youtube-embed';

describe('YouTube embed wrapper host', () => {
  it('maps a reserved, never-public name to loopback', () => {
    expect(YOUTUBE_EMBED_HOST.endsWith('.invalid')).toBe(true);
    expect(youtubeEmbedHostRule).toBe('MAP youtube-embed.invalid 127.0.0.1');
  });

  it('recognises requests for the wrapper host, with or without a port, any case', () => {
    expect(isYoutubeEmbedRequest('youtube-embed.invalid:43117')).toBe(true);
    expect(isYoutubeEmbedRequest('YouTube-Embed.invalid')).toBe(true);
    expect(isYoutubeEmbedRequest('127.0.0.1:43117')).toBe(false);
    expect(isYoutubeEmbedRequest('youtube-embed.invalid.example.com')).toBe(false);
    expect(isYoutubeEmbedRequest(undefined)).toBe(false);
  });

  it('serves only the wrapper under that host, never the app', () => {
    expect(youtubeEmbedAllows('/youtube-embed.html')).toBe(true);
    expect(youtubeEmbedAllows('/youtube-embed.js')).toBe(true);
    for (const p of ['/', '/index.html', '/assets/index.js', '/__migrate', '/youtube-embed.html/../index.html']) {
      expect(youtubeEmbedAllows(p)).toBe(false);
    }
  });
});
