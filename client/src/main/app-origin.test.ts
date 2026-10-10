import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppOrigin } from './app-origin';

describe('AppOrigin', () => {
  it('matches the loopback renderer origin exactly', () => {
    const o = new AppOrigin({ httpBases: ['http://127.0.0.1:43123'], fileRoot: null });
    expect(o.isAppUrl('http://127.0.0.1:43123/index.html')).toBe(true);
    expect(o.isAppUrl('http://127.0.0.1:43123/index.html#/chat')).toBe(true);
    // Different port / host / scheme → not the app.
    expect(o.isAppUrl('http://127.0.0.1:43124/index.html')).toBe(false);
    expect(o.isAppUrl('http://localhost:43123/index.html')).toBe(false);
    expect(o.isAppUrl('https://127.0.0.1:43123/index.html')).toBe(false);
    expect(o.isAppUrl('https://evil.example.com/')).toBe(false);
  });

  it('matches the dev server origin', () => {
    const o = new AppOrigin({ httpBases: ['http://localhost:5173/'], fileRoot: null });
    expect(o.isAppUrl('http://localhost:5173/src/main.tsx')).toBe(true);
    expect(o.isAppOrigin('http://localhost:5173')).toBe(true);
    expect(o.isAppOrigin('https://www.youtube-nocookie.com')).toBe(false);
  });

  it('never trusts file:// unless the renderer was loaded from file://', () => {
    const o = new AppOrigin({ httpBases: ['http://127.0.0.1:43123'], fileRoot: null });
    expect(o.isAppUrl('file:///Users/me/Downloads/evil.html')).toBe(false);
    expect(o.isAppOrigin('file://')).toBe(false);
  });

  it('trusts only files under the renderer root in the file:// fallback', () => {
    const root = join('/', 'opt', 'Boson', 'resources', 'app', 'out', 'renderer');
    const o = new AppOrigin({ httpBases: [], fileRoot: root });
    expect(o.isAppUrl(pathToFileURL(join(root, 'index.html')).href)).toBe(true);
    expect(o.isAppUrl(pathToFileURL(join(root, 'index.html')).href + '#/x')).toBe(true);
    // Sibling dir sharing the prefix, traversal, and arbitrary local files.
    expect(o.isAppUrl(pathToFileURL(root + '-evil/index.html').href)).toBe(false);
    expect(o.isAppUrl(pathToFileURL(root).href + '/../../evil.html')).toBe(false);
    expect(o.isAppUrl('file:///Users/me/Downloads/evil.html')).toBe(false);
  });

  it('rejects junk, empty and non-web schemes', () => {
    const o = new AppOrigin({ httpBases: ['http://127.0.0.1:43123'], fileRoot: null });
    for (const u of [undefined, null, '', 'not a url', 'data:text/html,hi', 'javascript:alert(1)', 'about:blank']) {
      expect(o.isAppUrl(u)).toBe(false);
    }
  });
});
