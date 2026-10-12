import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { placeholderTex, renderMarkdownDocument } from './markdown-doc';
import './MarkdownDoc.css';

// A pasted markdown document, rendered as one message body. The HTML is
// sanitised by renderMarkdownDocument; maths and diagrams are filled into its
// placeholders here, by libraries that produce safe output themselves.
export function MarkdownDoc({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdownDocument(text), [text]);
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    for (const node of el.querySelectorAll<HTMLElement>('[data-math]')) {
      try {
        node.innerHTML = katex.renderToString(placeholderTex(node), {
          displayMode: node.dataset.math === 'display',
          throwOnError: false,
          trust: false,
          output: 'htmlAndMathml',
        });
      } catch { /* leave the source showing */ }
    }
    const diagrams = [...el.querySelectorAll<HTMLElement>('[data-mermaid]')];
    if (diagrams.length) void renderDiagrams(diagrams);
  }, [html]);

  // Links within the document (#anchors: a table of contents, footnotes)
  // scroll inside this message rather than navigating.
  const onClick = (e: MouseEvent): void => {
    const a = (e.target as Element | null)?.closest?.('a');
    const href = a?.getAttribute('href');
    if (!a || !href?.startsWith('#')) return;
    e.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const target = [...(root.current?.querySelectorAll<HTMLElement>('[data-anchor], [id]') ?? [])]
      .find((n) => n.dataset.anchor === id || n.id === id);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return <div ref={root} class="md-doc" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Mermaid is big, so it's loaded the first time a diagram shows up.
let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
let diagramSeq = 0;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: prefersDarkDiagrams() ? 'dark' : 'default',
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-body') || undefined,
    });
    return mermaid;
  });
  return mermaidReady;
}

// Whether the app's background is dark (themes are user-editable).
function prefersDarkDiagrams(): boolean {
  const probe = document.createElement('div');
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--bg') || '#000';
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
  probe.remove();
  const [r = 0, g = 0, b = 0] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

async function renderDiagrams(nodes: HTMLElement[]): Promise<void> {
  let mermaid: typeof import('mermaid').default;
  try {
    mermaid = await loadMermaid();
  } catch {
    return;
  }
  for (const node of nodes) {
    const src = node.textContent ?? '';
    try {
      const { svg } = await mermaid.render(`md-mermaid-${++diagramSeq}`, src);
      if (!node.isConnected) continue;
      node.innerHTML = svg;
      node.classList.add('md-mermaid-done');
    } catch { /* invalid diagram: leave the source showing */ }
  }
}
