// @vitest-environment jsdom
// jsdom, not happy-dom: happy-dom's tree walking skips nodes, so DOMPurify
// (and these tests of what it lets through) would not see the real output.
import { describe, it, expect } from 'vitest';
import { placeholderTex, renderMarkdownDocument, slugify } from './markdown-doc';

const html = (lines: string[]): HTMLElement => {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdownDocument(lines.join('\n'));
  return el;
};

describe('renderMarkdownDocument', () => {
  it('renders headings with anchors, lists, quotes and rules', () => {
    const el = html(['# Kitchen Sink', ' ', '- one', '  - nested', ' ', '> quoted', ' ', '---', 'after']);
    expect(el.querySelector('h1')?.getAttribute('data-anchor')).toBe('kitchen-sink');
    expect(el.querySelector('ul ul li')?.textContent).toBe('nested');
    expect(el.querySelector('blockquote')?.textContent?.trim()).toBe('quoted');
    expect(el.querySelector('hr')).not.toBeNull();
  });

  it('highlights fenced code by language and keeps unknown languages plain', () => {
    const el = html(['```go', 'func main() {}', '```', ' ', '```nosuchlang', '<b>x</b>', '```']);
    const [go, plain] = [...el.querySelectorAll('pre code')];
    expect(go?.className).toContain('language-go');
    expect(go?.querySelector('.hljs-keyword')?.textContent).toBe('func');
    expect(plain?.textContent).toBe('<b>x</b>\n');
    expect(plain?.querySelector('b')).toBeNull();
  });

  it('renders GFM tables with alignment as classes', () => {
    const el = html(['| L | C | R |', '|:--|:-:|--:|', '| a | b | c |']);
    expect([...el.querySelectorAll('td')].map((td) => td.className)).toEqual(['md-align-left', 'md-align-center', 'md-align-right']);
    expect(el.querySelector('[style]')).toBeNull();
  });

  it('renders task lists, strikethrough, mark, emoji and footnotes', () => {
    const el = html(['- [x] done', '- [ ] todo', ' ', '~~gone~~ ==lit== :rocket: claim[^1]', ' ', '[^1]: source']);
    expect(el.querySelectorAll('.md-task')).toHaveLength(2);
    expect(el.querySelectorAll('.md-task-done')).toHaveLength(1);
    expect(el.querySelector('s')?.textContent).toBe('gone');
    expect(el.querySelector('mark')?.textContent).toBe('lit');
    expect(el.textContent).toContain('🚀');
    expect(el.querySelector('.footnotes')).not.toBeNull();
  });

  it('renders GitHub alerts', () => {
    const el = html(['> [!WARNING]', '> careful']);
    expect(el.querySelector('.md-alert.md-alert-warning')).not.toBeNull();
    expect(el.querySelector('.md-alert-title')?.textContent).toContain('Warning');
  });

  it('leaves maths and diagrams as placeholders, and prices as text', () => {
    const el = html(['inline $e^{i\\pi}$ and it costs $5 and $10', ' ', '$$', 'x^2', '$$', ' ', '```mermaid', 'graph LR; A-->B', '```']);
    const tex = [...el.querySelectorAll<HTMLElement>('[data-math]')];
    expect(tex.map((t) => [placeholderTex(t), t.dataset.math])).toEqual([['e^{i\\pi}', 'inline'], ['x^2', 'display']]);
    expect(el.textContent).toContain('costs $5 and $10');
    expect(el.querySelector('[data-mermaid]')?.textContent).toBe('graph LR; A-->B\n');
  });

  it('allows harmless HTML and drops the rest', () => {
    const el = html([
      '<details><summary>More</summary>',
      ' ',
      'Press <kbd>Ctrl</kbd>, H<sub>2</sub>O',
      ' ',
      '</details>',
      ' ',
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">js</a> <iframe src="https://example.com"></iframe>',
      '<span class="message-row-mention" style="position:fixed">styled</span>',
    ]);
    expect(el.querySelector('details summary')?.textContent).toBe('More');
    expect(el.querySelector('kbd')?.textContent).toBe('Ctrl');
    expect(el.querySelector('sub')?.textContent).toBe('2');
    expect(el.querySelector('script, iframe, [onerror], [style]')).toBeNull();
    expect(el.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect([...el.querySelectorAll('a')].some((a) => a.getAttribute('href')?.startsWith('javascript'))).toBe(false);
    expect(el.querySelector('.message-row-mention')).toBeNull();
  });

  it('opens web links outside, keeps anchors, and disarms relative links', () => {
    const el = html(['[web](https://example.com) [toc](#kitchen-sink) [rel](../README.md) <https://a.example>', 'x']);
    const links = [...el.querySelectorAll('a')];
    const web = links.find((a) => a.textContent === 'web')!;
    expect(web.getAttribute('target')).toBe('_blank');
    expect(web.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links.find((a) => a.textContent === 'toc')?.getAttribute('href')).toBe('#kitchen-sink');
    expect(links.find((a) => a.textContent === 'rel')?.hasAttribute('href')).toBe(false);
    expect(links.find((a) => a.textContent === 'https://a.example')?.getAttribute('href')).toBe('https://a.example');
  });

  it('shows images from the web only', () => {
    const el = html(['![a](https://placehold.co/1.png) ![b](file:///etc/passwd) <img src="data:image/png;base64,AA">']);
    expect([...el.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['https://placehold.co/1.png', null]);
  });
});

describe('slugify', () => {
  it('matches GitHub anchors', () => {
    expect(slugify('Blockquotes & Alerts')).toBe('blockquotes--alerts');
    expect(slugify('H1 — ATX style')).toBe('h1--atx-style');
  });
});

describe('attributes that are not links', () => {
  it('keep list starts, table spans and alert icons', () => {
    const el = html(['7. Seventh', '8. Eighth', ' ', '<table><tr><th rowspan="2">R</th><th colspan="2">C</th></tr></table>', ' ', '> [!NOTE]', '> x']);
    expect(el.querySelector('ol')?.getAttribute('start')).toBe('7');
    expect(el.querySelector('th')?.getAttribute('rowspan')).toBe('2');
    expect(el.querySelectorAll('th')[1]?.getAttribute('colspan')).toBe('2');
    expect(el.querySelector('.md-alert-title svg')?.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(el.querySelector('.md-alert-title svg path')?.getAttribute('d')).toBeTruthy();
  });

  it('strip href and src off elements that are not links or images', () => {
    const el = html(['<span href="https://e.com" src="https://e.com/x.png">x</span>', 'y']);
    expect(el.querySelector('span')?.attributes).toHaveLength(0);
  });
});

describe('front matter', () => {
  it('renders as a key/value table, not a rule and a heading', () => {
    const el = html(['---', 'title: "Kitchen Sink"', 'tags: [a, b]', 'description: A long', '  continued value', '---', ' ', '# Kitchen Sink']);
    expect([...el.querySelectorAll('.md-frontmatter tr')].map((r) => [r.querySelector('th')?.textContent, r.querySelector('td')?.textContent]))
      .toEqual([['title', 'Kitchen Sink'], ['tags', '[a, b]'], ['description', 'A long continued value']]);
    expect(el.querySelector('hr')).toBeNull();
    expect(el.querySelectorAll('h1, h2')).toHaveLength(1);
  });

  it('leaves a document that only starts with a rule alone', () => {
    const el = html(['---', 'Just some text', '---', 'more']);
    expect(el.querySelector('.md-frontmatter')).toBeNull();
  });
});
