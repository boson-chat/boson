// The user's own order for a server's channel list (drag to reorder in the
// sidebar). Saved per server in the session (SavedServerSession.channelOrder),
// which syncs to the Boson account, so it holds across relaunches,
// reconnects and devices.
//
// The saved order is a list of channel keys (lowercased names). Channels it
// doesn't name (joined since) keep the default order after the named ones;
// names in it that aren't in the list right now (still joining, a closed DM)
// are skipped. With no saved order the list keeps its default order.

/** Most names a saved order keeps, so the synced payload stays small. */
export const MAX_CHANNEL_ORDER = 500;

/** The key a channel is saved under: IRC names are case-insensitive. */
export function channelKey(name: string): string {
  return name.toLowerCase();
}

/**
 * `items` in the saved `order`: the ones it names first, by their place in
 * it, then the rest in their incoming (default) order. Stable; returns the
 * input order untouched when there is no saved order.
 */
export function applyChannelOrder<T>(
  items: readonly T[],
  order: readonly string[] | null | undefined,
  nameOf: (item: T) => string,
): T[] {
  if (!order || order.length === 0) return [...items];
  const rank = new Map<string, number>();
  order.forEach((k, i) => { if (!rank.has(k)) rank.set(k, i); });
  const ranked: Array<{ item: T; r: number }> = [];
  const rest: T[] = [];
  for (const item of items) {
    const r = rank.get(channelKey(nameOf(item)));
    if (r === undefined) rest.push(item);
    else ranked.push({ item, r });
  }
  ranked.sort((a, b) => a.r - b.r);
  return [...ranked.map((x) => x.item), ...rest];
}

/** Where a dragged row lands: beside `target`, above it or below it. */
export interface ChannelDrop { target: string; after: boolean }

/**
 * `names` (one section, top to bottom) after moving `dragged` beside the
 * drop target. Unchanged when either isn't in the list or it's a no-op.
 */
export function moveChannel(names: readonly string[], dragged: string, drop: ChannelDrop): string[] {
  const dk = channelKey(dragged);
  const tk = channelKey(drop.target);
  const rest = names.filter((n) => channelKey(n) !== dk);
  if (rest.length === names.length) return [...names];
  const at = rest.findIndex((n) => channelKey(n) === tk);
  if (at === -1) return [...names];
  const moved = names.find((n) => channelKey(n) === dk)!;
  rest.splice(drop.after ? at + 1 : at, 0, moved);
  return rest;
}

/** `names` with `name` moved one place up (-1) or down (+1); unchanged at an end. */
export function stepChannel(names: readonly string[], name: string, delta: -1 | 1): string[] {
  const i = names.findIndex((n) => channelKey(n) === channelKey(name));
  const j = i + delta;
  if (i === -1 || j < 0 || j >= names.length) return [...names];
  const next = [...names];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/**
 * The order to save after the user reordered one section into `section`
 * (its names, top to bottom). `saved` is the order saved so far; `shown` is
 * every name in the list right now (all sections, as displayed), and `keep`
 * says whether a saved name that isn't shown should hold its place (a
 * channel still being rejoined) or drop out (one the user left).
 *
 * The section's names are laid back into the slots they held, so the other
 * sections and the kept names don't move; shown names the saved order didn't
 * name yet are added in the order they're shown.
 */
export function mergeChannelOrder(
  saved: readonly string[] | null | undefined,
  shown: readonly string[],
  section: readonly string[],
  keep: (key: string) => boolean = () => false,
): string[] {
  const shownKeys = new Set(shown.map(channelKey));
  const full: string[] = [];
  const seen = new Set<string>();
  const add = (k: string): void => { if (!seen.has(k)) { seen.add(k); full.push(k); } };
  for (const k of saved ?? []) if (shownKeys.has(k) || keep(k)) add(k);
  // Shown names fill in after the saved ones, as displayed.
  for (const n of applyChannelOrder(shown, saved, (x) => x)) add(channelKey(n));

  const sectionKeys = section.map(channelKey);
  const inSection = new Set(sectionKeys);
  const slots = full.flatMap((k, i) => (inSection.has(k) ? [i] : []));
  // Every section name is shown, so it has a slot; lay them in, in order.
  slots.forEach((slot, i) => { full[slot] = sectionKeys[i]!; });
  return full.slice(0, MAX_CHANNEL_ORDER);
}

/** Whether `order` puts `items` anywhere other than their default order. */
export function isCustomOrder<T>(
  items: readonly T[],
  order: readonly string[] | null | undefined,
  nameOf: (item: T) => string,
): boolean {
  if (!order || order.length === 0) return false;
  const sorted = applyChannelOrder(items, order, nameOf);
  return sorted.some((item, i) => item !== items[i]);
}
