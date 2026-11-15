import { describe, it, expect } from 'vitest';
import {
  applyChannelOrder, channelKey, isCustomOrder, mergeChannelOrder, moveChannel, stepChannel, MAX_CHANNEL_ORDER,
} from './channel-order';

const id = (s: string): string => s;

describe('applyChannelOrder', () => {
  it('keeps the default order with no saved order', () => {
    expect(applyChannelOrder(['#a', '#b'], undefined, id)).toEqual(['#a', '#b']);
    expect(applyChannelOrder(['#a', '#b'], [], id)).toEqual(['#a', '#b']);
  });

  it('puts named channels in the saved order, case-insensitively', () => {
    expect(applyChannelOrder(['#a', '#B', '#c'], ['#c', '#b', '#a'], id)).toEqual(['#c', '#B', '#a']);
  });

  it('puts channels the order does not name at the end, in default order', () => {
    expect(applyChannelOrder(['#new1', '#a', '#new2', '#b'], ['#b', '#a'], id))
      .toEqual(['#b', '#a', '#new1', '#new2']);
  });

  it('skips saved names that are not in the list (parted, still joining)', () => {
    expect(applyChannelOrder(['#a', '#c'], ['#c', '#gone', '#a'], id)).toEqual(['#c', '#a']);
  });

  it('uses the first place of a name listed twice', () => {
    expect(applyChannelOrder(['#a', '#b'], ['#b', '#a', '#b'], id)).toEqual(['#b', '#a']);
  });

  it('works on objects through nameOf', () => {
    const items = [{ name: '#x' }, { name: '#y' }];
    expect(applyChannelOrder(items, ['#y'], (c) => c.name).map((c) => c.name)).toEqual(['#y', '#x']);
  });
});

describe('moveChannel', () => {
  const names = ['#a', '#b', '#c', '#d'];
  it('moves the dragged row beside the target', () => {
    expect(moveChannel(names, '#a', { target: '#c', after: true })).toEqual(['#b', '#c', '#a', '#d']);
    expect(moveChannel(names, '#d', { target: '#a', after: false })).toEqual(['#d', '#a', '#b', '#c']);
    expect(moveChannel(names, '#d', { target: '#b', after: true })).toEqual(['#a', '#b', '#d', '#c']);
  });
  it('is a no-op for itself or an unknown name', () => {
    expect(moveChannel(names, '#b', { target: '#b', after: true })).toEqual(names);
    expect(moveChannel(names, '#zz', { target: '#a', after: false })).toEqual(names);
    expect(moveChannel(names, '#a', { target: '#zz', after: false })).toEqual(names);
  });
  it('matches names case-insensitively and keeps their casing', () => {
    expect(moveChannel(['#Foo', '#bar'], '#foo', { target: '#BAR', after: true })).toEqual(['#bar', '#Foo']);
  });
});

describe('stepChannel', () => {
  it('moves one place up or down, and stops at the ends', () => {
    expect(stepChannel(['#a', '#b', '#c'], '#b', -1)).toEqual(['#b', '#a', '#c']);
    expect(stepChannel(['#a', '#b', '#c'], '#b', 1)).toEqual(['#a', '#c', '#b']);
    expect(stepChannel(['#a', '#b'], '#a', -1)).toEqual(['#a', '#b']);
    expect(stepChannel(['#a', '#b'], '#b', 1)).toEqual(['#a', '#b']);
    expect(stepChannel(['#a', '#b'], '#x', 1)).toEqual(['#a', '#b']);
  });
});

describe('mergeChannelOrder', () => {
  it('first reorder: saves every shown channel, in the new order', () => {
    expect(mergeChannelOrder(undefined, ['#a', '#b', 'nick'], ['#b', '#a'])).toEqual(['#b', '#a', 'nick']);
  });

  it('reordering one section leaves the other where it was', () => {
    const saved = ['#a', 'alice', '#b', 'bob'];
    expect(mergeChannelOrder(saved, ['#a', '#b', 'alice', 'bob'], ['bob', 'alice']))
      .toEqual(['#a', 'bob', '#b', 'alice']);
  });

  it('adds channels joined since, after the saved ones', () => {
    expect(mergeChannelOrder(['#b', '#a'], ['#a', '#b', '#new'], ['#new', '#b', '#a']))
      .toEqual(['#new', '#b', '#a']);
  });

  it('keeps a channel still being rejoined in its place, drops one that was left', () => {
    const saved = ['#c', '#joining', '#left', '#a'];
    const merged = mergeChannelOrder(saved, ['#a', '#c'], ['#a', '#c'], (k) => k === '#joining');
    expect(merged).toEqual(['#a', '#joining', '#c']);
    // Rejoined later: back where it was.
    expect(applyChannelOrder(['#c', '#a', '#joining'], merged, id)).toEqual(['#a', '#joining', '#c']);
  });

  it('stores lowercased keys', () => {
    expect(mergeChannelOrder(undefined, ['#Foo', '#Bar'], ['#Bar', '#Foo'])).toEqual(['#bar', '#foo']);
    expect(channelKey('#MiXeD')).toBe('#mixed');
  });

  it('caps the saved order', () => {
    const shown = Array.from({ length: MAX_CHANNEL_ORDER + 20 }, (_, i) => `#c${i}`);
    expect(mergeChannelOrder(undefined, shown, shown)).toHaveLength(MAX_CHANNEL_ORDER);
  });
});

describe('isCustomOrder', () => {
  it('is false with no order, or an order matching the default', () => {
    expect(isCustomOrder(['#a', '#b'], undefined, id)).toBe(false);
    expect(isCustomOrder(['#a', '#b'], ['#a', '#b', '#gone'], id)).toBe(false);
  });
  it('is true when the order moves something', () => {
    expect(isCustomOrder(['#a', '#b'], ['#b', '#a'], id)).toBe(true);
  });
});
