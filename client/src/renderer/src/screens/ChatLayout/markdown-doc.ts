import MarkdownIt, { type PluginSimple, type StateBlock, type StateCore, type StateInline } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import deflist from 'markdown-it-deflist';
import mark from 'markdown-it-mark';
import { full as emoji } from 'markdown-it-emoji';
import alerts from 'markdown-it-github-alerts';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

// Render a pasted markdown document (see markdown-blocks.ts) to HTML that is
// safe to put in the chat: CommonMark + GFM (tables, strikethrough, task
// lists, autolinks, footnotes, alerts) with highlighted code, plus ==mark==,
// :emoji:, definition lists, $maths$ and mermaid fences.
//
// Anyone on IRC can send this, so the output goes through DOMPurify with an
// allowlist: the tags markdown produces and a few harmless HTML ones people
// write in markdown (<details>, <kbd>, <sub>, <abbr>…). No scripts, styles,
// forms, frames or event handlers; links only to http(s)/mailto or an anchor
// in the same document; images only from http(s). Maths and diagrams leave
// placeholders (data-math / data-mermaid) that the component fills in after
// sanitising, with KaTeX (trust off) and mermaid (strict security level).

const md: MarkdownIt = new MarkdownIt({
  html: true, // filtered by the allowlist below
  linkify: true,
  // Each IRC line is a line: a run of lines without blank ones between them
  // (another client's paste) keeps its line breaks.
  breaks: true,
  highlight: (code, lang) => {
    if (!lang || !hljs.getLanguage(lang)) return '';
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return '';
    }
  },
});

// The plugins' own typings point at markdown-it's CommonJS types; at runtime
// they're the same plugin shape.
const plugin = (p: unknown): PluginSimple => p as PluginSimple;
md.use(plugin(footnote)).use(plugin(deflist)).use(plugin(mark)).use(plugin(emoji))
  .use((m) => alerts(m as never, { classPrefix: 'md-alert' }))
  .use(mathPlugin).use(taskLists);

const escapeHtml = md.utils.escapeHtml;

// GitHub-style heading slugs, so a table of contents' #links resolve.
export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

md.core.ruler.push('heading_anchors', (state: StateCore) => {
  const seen = new Map<string, number>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const text = inline?.children?.filter((t) => t.type === 'text' || t.type === 'code_inline').map((t) => t.content).join('') ?? '';
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    tokens[i]!.attrSet('data-anchor', n ? `${base}-${n}` : base);
  }
});

// Table alignment comes out as style="text-align:…", and styles are not
// allowed through; carry it as a class instead.
for (const rule of ['th_open', 'td_open'] as const) {
  md.renderer.rules[rule] = (tokens, idx, options, _env, self) => {
    const t = tokens[idx]!;
    const align = /text-align:\s*(left|center|right)/.exec(t.attrGet('style') ?? '')?.[1];
    if (align) {
      t.attrs = (t.attrs ?? []).filter(([k]) => k !== 'style');
      t.attrJoin('class', `md-align-${align}`);
    }
    return self.renderToken(tokens, idx, options);
  };
}

// ```mermaid and ```math fences become placeholders; the source stays visible
// until (and unless) the renderer replaces it.
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const t = tokens[idx]!;
  const lang = t.info.trim().split(/\s+/)[0]?.toLowerCase();
  if (lang === 'mermaid') {
    // The source travels as the text, not an attribute: DOMPurify drops
    // attribute values containing "-->", which is every other arrow.
    return `<div class="md-mermaid" data-mermaid="1"><pre><code>${escapeHtml(t.content)}</code></pre></div>\n`;
  }
  if (lang === 'math') return mathHtml(t.content.trim(), true);
  return defaultFence(tokens, idx, options, env, self);
};

// The TeX is the placeholder's text (shown as is until KaTeX replaces it).
function mathHtml(tex: string, display: boolean): string {
  const tag = display ? 'div' : 'span';
  return `<${tag} class="md-math${display ? ' md-math-block' : ''}" data-math="${display ? 'display' : 'inline'}">${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</${tag}>`;
}

// The TeX in a maths placeholder.
export function placeholderTex(node: Element): string {
  const text = node.textContent ?? '';
  return node.getAttribute('data-math') === 'display' ? text.slice(2, -2).trim() : text.slice(1, -1);
}

// $inline$ and $$block$$ maths. Inline follows pandoc's rule so prices aren't
// maths: the opening $ is followed by a non-space, the closing $ preceded by
// one and not followed by a digit ("$5 and $10" stays text).
function mathPlugin(mdi: MarkdownIt): void {
  mdi.inline.ruler.after('escape', 'math_inline', (state: StateInline, silent: boolean) => {
    const src = state.src;
    const start = state.pos;
    if (src[start] !== '$' || src[start + 1] === '$') return false;
    if (start + 1 >= state.posMax || /\s/.test(src[start + 1]!)) return false;
    let end = start + 1;
    for (;;) {
      end = src.indexOf('$', end);
      if (end < 0 || end >= state.posMax) return false;
      if (src[end - 1] === '\\') { end++; continue; }
      break;
    }
    if (/\s/.test(src[end - 1]!) || /\d/.test(src[end + 1] ?? '')) return false;
    if (!silent) {
      const token = state.push('math_inline', 'span', 0);
      token.content = src.slice(start + 1, end);
    }
    state.pos = end + 1;
    return true;
  });
  mdi.block.ruler.after('blockquote', 'math_block', (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
    const lineText = (n: number): string => state.src.slice(state.bMarks[n]! + state.tShift[n]!, state.eMarks[n]);
    const first = lineText(startLine);
    if (state.sCount[startLine]! - state.blkIndent >= 4 || !first.startsWith('$$')) return false;
    let body = first.slice(2);
    let line = startLine;
    let closed = body.trimEnd().endsWith('$$') && body.trim().length >= 2;
    if (closed) body = body.trimEnd().slice(0, -2);
    while (!closed && ++line < endLine) {
      const text = lineText(line);
      if (text.trimEnd().endsWith('$$')) {
        body += `\n${text.trimEnd().slice(0, -2)}`;
        closed = true;
      } else {
        body += `\n${text}`;
      }
    }
    // An unclosed $$ is text: as maths it would swallow the rest of the
    // document into one broken formula.
    if (!closed) return false;
    if (silent) return true;
    state.line = line + 1;
    const token = state.push('math_block', 'div', 0);
    token.block = true;
    token.content = body.trim();
    token.map = [startLine, state.line];
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  mdi.renderer.rules.math_inline = (tokens, idx) => mathHtml(tokens[idx]!.content, false);
  mdi.renderer.rules.math_block = (tokens, idx) => `${mathHtml(tokens[idx]!.content, true)}\n`;
}

// GFM task lists: "- [ ] todo" / "- [x] done" get a drawn checkbox.
function taskLists(mdi: MarkdownIt): void {
  mdi.core.ruler.after('inline', 'task_lists', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i]!;
      if (inline.type !== 'inline' || tokens[i - 1]!.type !== 'paragraph_open' || tokens[i - 2]!.type !== 'list_item_open') continue;
      const first = inline.children?.[0];
      const m = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
      if (!first || !m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      const done = m[1] !== ' ';
      box.content = `<span class="md-task${done ? ' md-task-done' : ''}" role="img" aria-label="${done ? 'done' : 'not done'}"></span>`;
      inline.children!.unshift(box);
      tokens[i - 2]!.attrJoin('class', 'md-task-item');
    }
  });
}

const ALLOWED_TAGS = [
  // What markdown produces.
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'del', 'mark', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'dl', 'dt', 'dd',
  'sup', 'sub', 'section', 'span', 'div', 'svg', 'path',
  // Harmless HTML people use in markdown.
  'details', 'summary', 'kbd', 'abbr', 'ins', 'small', 'u', 'b', 'i', 'q', 'cite', 'var', 'samp', 'tfoot', 'caption',
];
const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class', 'id', 'colspan', 'rowspan', 'start', 'open', 'role', 'align',
  'aria-label', 'aria-hidden', 'viewBox', 'd', 'width', 'height', 'version', 'fill-rule',
];
const OUR_DATA_ATTRS = new Set(['data-math', 'data-mermaid', 'data-anchor']);
// Classes we style. Anything else (a raw <span class="message-row-mention">)
// is dropped so HTML in a message can't borrow the app's own looks.
const CLASS_RE = /^(?:hljs|language-|md-|footnote|octicon|mr-2$)/;

// Our own DOMPurify instance: the hook must not touch other users of the
// shared one (mermaid sanitises its SVG with it).
let purify: ReturnType<typeof DOMPurify> | null = null;
function sanitizer(): ReturnType<typeof DOMPurify> {
  if (purify) return purify;
  purify = DOMPurify(window);
  // Data attributes are off except the placeholders and anchors we emit.
  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (OUR_DATA_ATTRS.has(data.attrName)) data.forceKeepAttr = true;
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.hasAttribute('class')) {
      const keep = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => CLASS_RE.test(c));
      if (keep.length) el.setAttribute('class', keep.join(' '));
      else el.removeAttribute('class');
    }
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        el.removeAttribute('target');
      } else if (/^(?:https?:|mailto:)/i.test(href)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('class', `${el.getAttribute('class') ?? ''} md-link`.trim());
      } else {
        el.removeAttribute('href');
      }
    }
    if (el.tagName !== 'A') el.removeAttribute('href');
    if (el.tagName !== 'IMG') el.removeAttribute('src');
    if (el.tagName === 'IMG') {
      if (!/^https?:/i.test(el.getAttribute('src') ?? '')) el.removeAttribute('src');
      el.setAttribute('loading', 'lazy');
    }
  });
  return purify;
}

// YAML front matter (--- key: value --- at the very top, as in a Hugo or
// Jekyll page): shown as a small key/value table rather than a rule, some
// text and a stray heading. Returns null when the text doesn't open with it.
export function splitFrontMatter(text: string): { fields: Array<[string, string]>; body: string } | null {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
  if (end < 2 || end > 60) return null;
  const fields: Array<[string, string]> = [];
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (m) fields.push([m[1]!, (m[2] ?? '').trim()]);
    else if (/^\s/.test(line) && fields.length) fields[fields.length - 1]![1] += ` ${line.trim()}`;
    else return null;
  }
  if (!fields.length) return null;
  return { fields, body: lines.slice(end + 1).join('\n') };
}

function frontMatterHtml(fields: Array<[string, string]>): string {
  const rows = fields.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v.replace(/^(["'])(.*)\1$/, '$2'))}</td></tr>`).join('');
  return `<table class="md-frontmatter"><tbody>${rows}</tbody></table>\n`;
}

export function renderMarkdownDocument(text: string): string {
  const front = splitFrontMatter(text);
  const html = front ? frontMatterHtml(front.fields) + md.render(front.body) : md.render(text);
  return sanitizer().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [...ALLOWED_ATTR, 'target', 'rel', 'loading'],
    ALLOW_DATA_ATTR: false,
    // No ALLOWED_URI_REGEXP: DOMPurify tests it against every attribute's
    // value (start="7" would fail). href and src are checked in the hook.
  });
}
