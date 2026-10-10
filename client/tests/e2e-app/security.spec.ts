// Security smoke tests for the main-window navigation guard and the
// renderer's drop guard, against the real built app.
import { test, expect, continueAsGuest, uid } from './fixtures';

test('main window cannot be navigated away from the app origin', async ({ launchApp }) => {
  const { page, openedExternally } = await launchApp();
  await continueAsGuest(page, `sec${uid()}`);
  const appUrl = page.url();
  expect(new URL(appUrl).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  // NB: after a navigation that main cancels, Playwright keeps treating the
  // frame as "navigating" and its actions (click/fill) wait for it forever.
  // So everything below sticks to evaluate() + assertions, which don't.
  const href = (): Promise<string> => page.evaluate(() => window.location.href);

  // 1. A script-driven navigation to a web page is cancelled in main and the
  //    URL is handed to the OS browser instead (stubbed in the fixture).
  await page.evaluate(() => { window.location.href = 'https://example.com/e2e-nav-guard'; });
  await expect.poll(openedExternally).toContain('https://example.com/e2e-nav-guard');
  expect(await href()).toBe(appUrl);

  // 2. Non-web schemes are dropped outright — not navigated, not handed off.
  await page.evaluate(() => { window.location.href = 'file:///etc/passwd'; });
  await page.waitForTimeout(500);
  expect(await href()).toBe(appUrl);
  expect(await openedExternally()).not.toContain('file:///etc/passwd');

  // 3. window.open never creates a second window; web URLs go to the OS.
  const windowsBefore = page.context().pages().length;
  await page.evaluate(() => { window.open('https://example.com/e2e-window-open', '_blank'); });
  await expect.poll(openedExternally).toContain('https://example.com/e2e-window-open');
  expect(page.context().pages().length).toBe(windowsBefore);

  // The app document survived all of it: same URL, same rendered state, and
  // the UI still reacts to input.
  expect(await href()).toBe(appUrl);
  expect(await page.evaluate(() => document.querySelector('h1')?.textContent)).toBe('Server Directory');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Advanced');
    btn?.click();
  });
  await expect.poll(() => page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim() === '+ Add server manually'),
  )).toBe(true);
});

test('dropping a link or file onto the window is swallowed', async ({ launchApp }) => {
  const { page } = await launchApp();
  await expect(page.getByRole('button', { name: 'Continue without an account' })).toBeVisible();
  const url = page.url();

  // Chromium's default for a drop is to navigate to the dropped link/file;
  // the renderer guard must cancel both dragover and drop (outside inputs).
  const prevented = await page.evaluate(() => {
    const fire = (type: 'dragover' | 'drop', dt: DataTransfer): boolean => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const link = new DataTransfer();
    link.setData('text/uri-list', 'https://example.com/dropped');
    const file = new DataTransfer();
    file.items.add(new File(['x'], 'evil.html', { type: 'text/html' }));
    return {
      linkOver: fire('dragover', link), linkDrop: fire('drop', link),
      fileOver: fire('dragover', file), fileDrop: fire('drop', file),
    };
  });
  expect(prevented).toEqual({ linkOver: true, linkDrop: true, fileOver: true, fileDrop: true });
  expect(page.url()).toBe(url);
});
