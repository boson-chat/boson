import { render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

// Renders its children into a <div> at the end of <body>, above Modals and
// Sheets, and clear of any ancestor that clips or transforms (a Modal's
// panel). The shared package has no preact/compat, so no createPortal: a
// second render root does the same for content that needs no context.
export function Layer({ children, class: cls }: { children: ComponentChildren; class: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = document.createElement('div');
    el.className = cls;
    document.body.appendChild(el);
    host.current = el;
    return () => {
      render(null, el);
      el.remove();
      host.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (host.current) render(<>{children}</>, host.current);
  });
  return null;
}
