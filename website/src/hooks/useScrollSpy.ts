import { useEffect, useState } from 'preact/hooks';

/**
 * Track which #anchor section is currently in view so a sticky TOC can
 * mark its corresponding link as active. Uses IntersectionObserver with
 * an asymmetric rootMargin — the section becomes "active" when its top
 * crosses ~20% from the viewport top, and stays active until the next
 * section's top crosses the same line. That feels right for reading:
 * the highlighted entry is the one your eye is currently on, not the
 * one farthest down that happens to still be in the viewport.
 *
 * Returns the id of the active section, or `null` if nothing is in
 * view yet (typically only at the very top of the page before the
 * first section has scrolled into the trigger zone).
 */
export function useScrollSpy(
  ids: readonly string[],
  rootMargin = '-20% 0px -70% 0px',
): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    if (typeof window === 'undefined' || ids.length === 0) return;

    const observed = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        // Collect every section currently intersecting the trigger band,
        // then pick the one whose top is highest in the document — that
        // is the one the reader is most plausibly on right now. Multiple
        // sections can intersect simultaneously when a small section
        // sits between two larger ones.
        const visible: { id: string; top: number }[] = [];
        for (const entry of entries) {
          observed.add(entry.target.id);
          if (!entry.isIntersecting) continue;
          visible.push({
            id: entry.target.id,
            top: (entry.target as HTMLElement).getBoundingClientRect().top,
          });
        }
        if (visible.length === 0) return;
        visible.sort((a, b) => a.top - b.top);
        setActive(visible[0].id);
      },
      { rootMargin, threshold: 0 },
    );

    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [ids.join('|'), rootMargin]);

  return active;
}
