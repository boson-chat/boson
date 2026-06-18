// Pure scroll-position resolver for the message list. Extracted into its own
// module so both ChatArea.tsx and message-render.tsx can import it without a
// cycle (ChatArea imports MessageList from message-render; message-render needs
// this resolver for its scroll effect). ChatArea re-exports `resolveScrollTop`
// for backwards-compatible test imports.

// Tolerance (px) for "is the viewport at the bottom?" — absorbs sub-pixel
// rounding and a partially-visible last line.
export const AT_BOTTOM_SLACK = 24;

// Decide the message list's new scrollTop after a re-render, or null to leave
// it untouched. Pure so it's unit-testable without jsdom layout.
//   - channel switch        → jump to the bottom (latest)
//   - older history prepended → keep the same content under the viewport
//   - otherwise (live append, or an unrelated emit like a loading-flag /
//     typing / member update) → only stick to the bottom if the user was
//     ALREADY there; if they'd scrolled up to read history, leave them put.
// That last rule fixes "load older jumps to the bottom": the loading-flag emit
// fired before any messages arrived and used to force a scroll to bottom.
// `opts.atBottom`, when provided, is the caller's live "is the viewport parked
// at the bottom?" reading, tracked from real scroll events. Prefer it: a
// baseline captured at the previous effect run (prev.scrollHeight) goes stale
// whenever content height changes without re-running the effect — async embed/
// image loads, activity-group collapse, or front-trim at the in-memory cap —
// and a stale baseline made live appends stop sticking to the bottom. When the
// flag is absent we fall back to the height comparison (keeps the resolver
// usable from pure tests that only supply layout metrics).
export function resolveScrollTop(
  prev: { name?: string; count: number; firstId: string; scrollHeight: number },
  next: { name?: string; count: number; firstId: string },
  el: { scrollTop: number; clientHeight: number; scrollHeight: number },
  opts?: { atBottom?: boolean },
): number | null {
  const switchedChannel = next.name !== prev.name;
  if (switchedChannel) return el.scrollHeight;
  const prepended = next.count > prev.count && next.firstId !== prev.firstId;
  if (prepended) return el.scrollTop + (el.scrollHeight - prev.scrollHeight);
  const wasAtBottom =
    opts?.atBottom ?? el.scrollTop + el.clientHeight >= prev.scrollHeight - AT_BOTTOM_SLACK;
  return wasAtBottom ? el.scrollHeight : null;
}
