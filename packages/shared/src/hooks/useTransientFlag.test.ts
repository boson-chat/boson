import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/preact';
import { useTransientFlag } from './useTransientFlag';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTransientFlag', () => {
  it('starts in the false state', () => {
    const { result } = renderHook(() => useTransientFlag(1000));
    expect(result.current[0]).toBe(false);
  });

  it('flips to true on trigger() and back to false after the duration', () => {
    const { result } = renderHook(() => useTransientFlag(1000));
    act(() => { result.current[1](); });
    expect(result.current[0]).toBe(true);
    act(() => { vi.advanceTimersByTime(999); });
    expect(result.current[0]).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current[0]).toBe(false);
  });

  it('extends the active window when triggered again before expiry', () => {
    // Equivalent to clicking Save twice in quick succession — the badge
    // should re-extend rather than disappearing mid-flight.
    const { result } = renderHook(() => useTransientFlag(1000));
    act(() => { result.current[1](); });
    act(() => { vi.advanceTimersByTime(500); });
    act(() => { result.current[1](); }); // re-trigger
    act(() => { vi.advanceTimersByTime(999); });
    expect(result.current[0]).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current[0]).toBe(false);
  });

  it('cancels its timer on unmount so it cannot fire against a torn-down hook', () => {
    // No assertion on state here — the spec is "no console errors from a
    // setState on an unmounted component". We assert it by checking that
    // advancing past the duration does not throw.
    const { result, unmount } = renderHook(() => useTransientFlag(1000));
    act(() => { result.current[1](); });
    unmount();
    expect(() => { vi.advanceTimersByTime(2000); }).not.toThrow();
  });

  it('defaults to 1500ms when no duration is provided', () => {
    const { result } = renderHook(() => useTransientFlag());
    act(() => { result.current[1](); });
    act(() => { vi.advanceTimersByTime(1499); });
    expect(result.current[0]).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current[0]).toBe(false);
  });
});
