// The UI's sizes are a desktop's (14px text, 4px spacing steps), small on a
// phone held at arm's length. The phone app shows everything a size up, in
// proportion: the page is laid out PHONE_SCALE times narrower than the
// screen and the webview scales it to fit, so text, spacing, icons and tap
// targets all grow together and the layout stays in CSS pixels (touch
// coordinates, popover positions and 100vh all agree). The iOS shell pins
// the webview's zoom to the same scale (desktop/build/ios/main.m).
export const PHONE_SCALE = 1.15;

/** On a phone (iOS app), lay the page out at PHONE_SCALE. Call before the first render. */
export function applyPhoneScale(platform: string): void {
  if (platform !== 'ios' || typeof document === 'undefined') return;
  if (Math.min(screen.width, screen.height) > 700) return; // an iPad keeps 1:1
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  // An explicit width: with width=device-width iOS keeps the full-width
  // layout and only zooms it, overflowing the screen. Follows rotation
  // (screen.width/height stay portrait on iOS).
  const fit = (): void => {
    const landscape = window.matchMedia('(orientation: landscape)').matches;
    const width = Math.round(Math.max(1, landscape ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height)) / PHONE_SCALE);
    const s = PHONE_SCALE;
    meta.setAttribute('content',
      `width=${width}, initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}, user-scalable=no, viewport-fit=cover`);
  };
  fit();
  window.matchMedia('(orientation: landscape)').addEventListener('change', fit);
}
