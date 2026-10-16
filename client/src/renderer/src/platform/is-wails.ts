// Whether the page is served by the Wails desktop shell. The shell marks
// index.html with <meta name="boson-shell" content="wails"> (desktop/assets.go):
// the origin alone (wails://localhost, http://wails.localhost) doesn't cover
// a server-mode build, which is served from http://localhost:<port>.
// Kept apart from platform/wails.ts so checking doesn't load the runtime.
export function isWailsPage(): boolean {
  return document.querySelector('meta[name="boson-shell"]')?.getAttribute('content') === 'wails';
}
