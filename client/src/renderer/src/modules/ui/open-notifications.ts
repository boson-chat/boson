// Opening the bell's list from somewhere other than the title bar (a
// phone's conversation header, where the title bar steps aside). The app
// root, which owns the list, registers the opener.
let opener: (() => void) | null = null;

export function setNotificationsOpener(fn: (() => void) | null): void {
  opener = fn;
}

export function openNotifications(): void {
  opener?.();
}

export function hasNotificationsOpener(): boolean {
  return opener !== null;
}
