import { describe, it, expect } from 'vitest';
import { classifyUrl, classifyMessage, extractUrls } from './classify';

describe('classifyUrl', () => {
  it('classifies images by extension', () => {
    expect(classifyUrl('https://i.imgur.com/a.png')).toMatchObject({ kind: 'image', ext: 'png', domain: 'i.imgur.com' });
    expect(classifyUrl('https://x.com/pic.JPEG')?.kind).toBe('image');
  });
  it('parses youtube ids from watch/youtu.be/shorts', () => {
    expect(classifyUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toMatchObject({ kind: 'youtube', youtubeId: 'dQw4w9WgXcQ' });
    expect(classifyUrl('https://youtu.be/dQw4w9WgXcQ')?.youtubeId).toBe('dQw4w9WgXcQ');
    expect(classifyUrl('https://youtube.com/shorts/dQw4w9WgXcQ')?.youtubeId).toBe('dQw4w9WgXcQ');
  });
  it('classifies Spotify track/playlist/album URLs (incl. intl + query)', () => {
    expect(classifyUrl('https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6'))
      .toMatchObject({ kind: 'spotify', spotifyType: 'track', spotifyId: '6rqhFgbbKwnb9MLmUQDhG6' });
    expect(classifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'))
      .toMatchObject({ kind: 'spotify', spotifyType: 'playlist' });
    expect(classifyUrl('https://open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3')?.spotifyType).toBe('album');
    // A Spotify profile/non-entity path is just a website.
    expect(classifyUrl('https://open.spotify.com/user/someone')?.kind).toBe('website');
  });
  it('classifies browser-playable video files as video, others as file', () => {
    expect(classifyUrl('https://cdn.example.com/clip.mp4')).toMatchObject({ kind: 'video', ext: 'mp4' });
    expect(classifyUrl('https://cdn.example.com/clip.WEBM')?.kind).toBe('video');
    expect(classifyUrl('https://cdn.example.com/clip.mov')?.kind).toBe('video');
    // mkv/avi aren't reliably playable in Chromium → offered as a download.
    expect(classifyUrl('https://cdn.example.com/clip.mkv')?.kind).toBe('file');
    expect(classifyUrl('https://cdn.example.com/clip.avi')?.kind).toBe('file');
  });
  it('classifies downloadable files and flags executables', () => {
    expect(classifyUrl('https://host/app.zip')).toMatchObject({ kind: 'file', ext: 'zip', executable: false });
    expect(classifyUrl('https://host/setup.exe')).toMatchObject({ kind: 'file', ext: 'exe', executable: true });
    expect(classifyUrl('https://host/run.sh')).toMatchObject({ kind: 'file', executable: true });
  });
  it('falls back to website for plain pages and strips www', () => {
    expect(classifyUrl('https://www.example.com/post/123')).toMatchObject({ kind: 'website', domain: 'example.com' });
  });
  it('rejects non-http(s) and garbage', () => {
    expect(classifyUrl('ftp://host/x')).toBeNull();
    expect(classifyUrl('not a url')).toBeNull();
  });
});

describe('extractUrls / classifyMessage', () => {
  it('extracts all urls and de-dupes', () => {
    const text = 'see https://a.com/x.png and https://a.com/x.png and https://youtu.be/dQw4w9WgXcQ';
    expect(extractUrls(text)).toHaveLength(3);
    const c = classifyMessage(text);
    expect(c).toHaveLength(2);
    expect(c.map((x) => x.kind)).toEqual(['image', 'youtube']);
  });
  it('returns empty for a message with no links', () => {
    expect(classifyMessage('just chatting')).toEqual([]);
  });
});
