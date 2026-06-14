import { describe, it, expect, beforeEach } from 'vitest';
import { getPanelWidth, setPanelWidth, PANEL_BOUNDS } from './panel-sizes';

beforeEach(() => localStorage.clear());

describe('panel-sizes', () => {
  it('returns the default when nothing is stored', () => {
    expect(getPanelWidth('channels')).toBe(PANEL_BOUNDS.channels.def);
    expect(getPanelWidth('members')).toBe(PANEL_BOUNDS.members.def);
  });

  it('persists a width and reads it back (survives a reload)', () => {
    setPanelWidth('channels', 300);
    expect(getPanelWidth('channels')).toBe(300);
  });

  it('clamps to the configured bounds on write', () => {
    expect(setPanelWidth('channels', 10_000)).toBe(PANEL_BOUNDS.channels.max);
    expect(setPanelWidth('channels', 1)).toBe(PANEL_BOUNDS.channels.min);
  });

  it('clamps an out-of-range stored value on read', () => {
    localStorage.setItem('boson:panel-sizes:v1', JSON.stringify({ members: 99999 }));
    expect(getPanelWidth('members')).toBe(PANEL_BOUNDS.members.max);
  });

  it('keeps the two panels independent', () => {
    setPanelWidth('channels', 260);
    setPanelWidth('members', 200);
    expect(getPanelWidth('channels')).toBe(260);
    expect(getPanelWidth('members')).toBe(200);
  });
});
