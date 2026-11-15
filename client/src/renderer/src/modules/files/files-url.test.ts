import { describe, it, expect } from 'vitest';
import { mediaFor, parseFilesUrl } from './files-url';

const known = (o: string) => o === 'https://files.example.org' || o === 'http://127.0.0.1:4321';
const ID = 'AbCdEfGhIjKlMnOpQrStUv';

describe('parseFilesUrl', () => {
  it('recognises /f/<id>/<name> on a known files host', () => {
    expect(parseFilesUrl(`https://files.example.org/f/${ID}/My%20cat.png`, known)).toEqual({
      url: `https://files.example.org/f/${ID}/My%20cat.png`,
      origin: 'https://files.example.org',
      id: ID,
      name: 'My cat.png',
      ext: 'png',
      media: 'image',
    });
    expect(parseFilesUrl(`https://FILES.example.org/f/${ID}x/clip.webm`, known)?.media).toBe('video');
    expect(parseFilesUrl(`http://127.0.0.1:4321/f/${ID}/song.mp3`, known)?.media).toBe('audio');
    expect(parseFilesUrl(`https://files.example.org/f/${ID}/archive.zip`, known)?.media).toBe('file');
  });
  it('ignores other hosts, other paths and short ids', () => {
    expect(parseFilesUrl(`https://files.evil.example/f/${ID}/a.png`, known)).toBeNull();
    expect(parseFilesUrl(`https://files.example.org/v1/me/usage`, known)).toBeNull();
    expect(parseFilesUrl(`https://files.example.org/f/short/a.png`, known)).toBeNull();
    expect(parseFilesUrl(`https://files.example.org/f/${ID}/a.png/more`, known)).toBeNull();
    expect(parseFilesUrl(`https://user:pw@files.example.org/f/${ID}/a.png`, known)).toBeNull();
    expect(parseFilesUrl('not a url', known)).toBeNull();
    expect(parseFilesUrl(`ftp://files.example.org/f/${ID}/a.png`, known)).toBeNull();
  });
  it('types by extension; svg and html are plain files', () => {
    expect(mediaFor('a.JPEG')).toBe('image');
    expect(mediaFor('a.svg')).toBe('file');
    expect(mediaFor('a.html')).toBe('file');
    expect(mediaFor('a.wav')).toBe('audio');
    expect(mediaFor('noext')).toBe('file');
  });
});
