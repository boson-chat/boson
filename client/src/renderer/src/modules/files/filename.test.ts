import { describe, it, expect } from 'vitest';
import { MAX_NAME, sanitizeFilename, splitExt } from './filename';

describe('splitExt', () => {
  it('splits the last extension only', () => {
    expect(splitExt('photo.tar.gz')).toEqual(['photo.tar', '.gz']);
    expect(splitExt('IMG_0042.JPG')).toEqual(['IMG_0042', '.JPG']);
  });
  it('has none for dotfiles, trailing dots and names without one', () => {
    expect(splitExt('.bashrc')).toEqual(['.bashrc', '']);
    expect(splitExt('README')).toEqual(['README', '']);
    expect(splitExt('notes.')).toEqual(['notes.', '']);
    expect(splitExt('a.b c')).toEqual(['a.b c', '']);
  });
});

describe('sanitizeFilename', () => {
  it('keeps a good name as it is', () => {
    expect(sanitizeFilename('holiday photo.jpg', 'IMG_1.jpg')).toBe('holiday photo.jpg');
  });
  it("keeps the original's extension when the new name has none", () => {
    expect(sanitizeFilename('beach', 'IMG_0042.jpg')).toBe('beach.jpg');
    expect(sanitizeFilename('  beach  ', 'IMG_0042.jpg')).toBe('beach.jpg');
  });
  it('respects an extension the user typed', () => {
    expect(sanitizeFilename('notes.md', 'notes.txt')).toBe('notes.md');
  });
  it('drops paths, control and unsafe characters', () => {
    expect(sanitizeFilename('../../etc/passwd', 'x.txt')).toBe('passwd.txt');
    expect(sanitizeFilename('C:\\Users\\me\\report.pdf', 'r.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.png', 'x.png')).toBe('abcdefgh.png');
    expect(sanitizeFilename('tab\there\nnew.txt', 'x.txt')).toBe('tabherenew.txt');
  });
  it('collapses whitespace and strips leading and trailing dots', () => {
    expect(sanitizeFilename('my    cat\u00a0pic.png', 'x.png')).toBe('my cat pic.png');
    expect(sanitizeFilename('...hidden.txt', 'x.txt')).toBe('hidden.txt');
    expect(sanitizeFilename('trailing.png...', 'x.png')).toBe('trailing.png');
  });
  it('falls back to the original, then to "file"', () => {
    expect(sanitizeFilename('', 'IMG_0042.jpg')).toBe('IMG_0042.jpg');
    expect(sanitizeFilename('???', 'IMG_0042.jpg')).toBe('IMG_0042.jpg');
    expect(sanitizeFilename('', '')).toBe('file');
  });
  it('guards Windows device names', () => {
    expect(sanitizeFilename('CON', 'a.txt')).toBe('_CON.txt');
    expect(sanitizeFilename('nul.png', 'a.png')).toBe('_nul.png');
  });
  it('caps the length from the stem, never the extension', () => {
    const out = sanitizeFilename('a'.repeat(500), 'x.jpeg');
    expect(out.length).toBe(MAX_NAME);
    expect(out.endsWith('.jpeg')).toBe(true);
  });
  it('keeps non-Latin names', () => {
    expect(sanitizeFilename('фото отпуск', 'p.webp')).toBe('фото отпуск.webp');
  });
});
