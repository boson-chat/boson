// What a link's preview fetch answered (an unfurled card, a Spotify page),
// by kind and URL, in memory. A row scrolled away and back (the windowed
// list remounts it) or a conversation shown again renders its card at
// once, at its final height, instead of a "Loading preview…" chip that
// grows into the card a moment later: the list doesn't move under the
// reader. Bounded; emptied at sign-out.

const MAX = 500;
const settled = new Map<string, unknown>();

// The settled answer (null: there was none), or undefined when unknown.
export function memoGet<T>(kind: string, url: string): T | null | undefined {
  const k = `${kind} ${url}`;
  return settled.has(k) ? (settled.get(k) as T | null) : undefined;
}

export function memoSet<T>(kind: string, url: string, value: T | null): void {
  const k = `${kind} ${url}`;
  settled.delete(k);
  settled.set(k, value);
  while (settled.size > MAX) settled.delete(settled.keys().next().value!);
}

// fetch(url), remembered.
export function memoFetch<T>(kind: string, url: string, fetch: (url: string) => Promise<T | null>): Promise<T | null> {
  return fetch(url).then((v) => {
    memoSet(kind, url, v ?? null);
    return v ?? null;
  });
}

export function clearEmbedMemo(): void {
  settled.clear();
}
