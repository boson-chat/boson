import { describe, it, expect } from 'vitest';
import { parseOg, absolutize, isBlockedHost } from './og-parse';

describe('parseOg', () => {
  it('extracts OpenGraph tags (attr order-agnostic) + decodes entities', () => {
    const html = `<head>
      <meta property="og:title" content="Hello &amp; World">
      <meta content="A nice post" name="og:description">
      <meta property="og:image" content="https://cdn.example.com/x.png">
      <meta property="og:site_name" content="Example">
    </head>`;
    expect(parseOg(html, 'https://example.com/p')).toEqual({
      url: 'https://example.com/p',
      title: 'Hello & World',
      description: 'A nice post',
      image: 'https://cdn.example.com/x.png',
      siteName: 'Example',
    });
  });

  it('falls back to <title> and meta description', () => {
    const html = '<head><title>Just a Title</title><meta name="description" content="desc"></head>';
    const c = parseOg(html, 'https://x.com');
    expect(c.title).toBe('Just a Title');
    expect(c.description).toBe('desc');
    expect(c.image).toBeUndefined();
  });

  it('resolves a relative og:image against the page URL', () => {
    const html = '<meta property="og:image" content="/img/cover.jpg">';
    expect(parseOg(html, 'https://example.com/blog/post').image).toBe('https://example.com/img/cover.jpg');
  });

  it('extracts author + date from meta tags and JSON-LD', () => {
    const meta = `<meta name="author" content="Jane Doe">
      <meta property="article:published_time" content="2025-02-20T10:00:00Z">`;
    const m = parseOg(meta, 'https://blog.example.com/p');
    expect(m.author).toBe('Jane Doe');
    expect(m.date).toBe('2025-02-20T10:00:00Z');

    // YouTube-style JSON-LD (author object + uploadDate), emitted late in the doc.
    const yt = `${'x'.repeat(5000)}<script type="application/ld+json">
      {"@type":"VideoObject","author":{"@type":"Person","name":"abe's projects"},"uploadDate":"2025-02-20T10:00:44-08:00"}
      </script><meta property="og:title" content="I built my ideal mini computer">`;
    const c = parseOg(yt, 'https://www.youtube.com/watch?v=x');
    expect(c.title).toBe('I built my ideal mini computer');
    expect(c.author).toBe("abe's projects");
    expect(c.date).toBe('2025-02-20T10:00:44-08:00');
  });
});

describe('absolutize', () => {
  it('keeps absolute https, resolves relative, rejects non-http', () => {
    expect(absolutize('https://a.com/x.png', 'https://b.com')).toBe('https://a.com/x.png');
    expect(absolutize('/x.png', 'https://b.com/p')).toBe('https://b.com/x.png');
    expect(absolutize('javascript:alert(1)', 'https://b.com')).toBeUndefined();
    expect(absolutize(undefined, 'https://b.com')).toBeUndefined();
  });
});

describe('isBlockedHost (SSRF guard)', () => {
  it('blocks loopback / private / link-local', () => {
    for (const h of ['localhost', '127.0.0.1', '0.0.0.0', '::1', '10.0.0.5', '192.168.1.2', '172.16.0.1', '169.254.1.1', 'foo.local']) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it('allows ordinary public hosts', () => {
    for (const h of ['example.com', 'youtube.com', '8.8.8.8', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });
});
