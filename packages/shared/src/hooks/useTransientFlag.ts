import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// Returns a boolean flag + a `trigger()` that flips it true for
// `durationMs`, then automatically clears it. The canonical use is the
// "Saved" / "Copied" confirmation badge that appears after a successful
// action, lingers briefly, then fades out — same pattern as Linear,
// Slack message-copy, etc.
//
// Triggers re-set the timer if the flag is already active, so the user
// sees the confirmation re-extend rather than blink. The timer is also
// cancelled if the component unmounts, so a delayed clearTimeout can't
// fire a state update against a torn-down hook.
export function useTransientFlag(durationMs = 1500): [boolean, () => void] {
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trigger = useCallback(() => {
    setActive(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setActive(false);
      timer.current = null;
    }, durationMs);
  }, [durationMs]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return [active, trigger];
}
