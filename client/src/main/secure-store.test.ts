import { describe, it } from 'vitest';

// The main-process SecureStore depends on Electron's `safeStorage` and `app`
// modules, which can only be required inside a running Electron process.
// Vitest runs under happy-dom (no Electron) so we cannot import it here.
//
// TODO(2026-Q2): once we add Playwright e2e coverage that boots a real
// Electron main process, exercise SecureStore end-to-end there:
//   - encryptString/decryptString round-trip
//   - file written to userData with 0600 permissions
//   - corrupted file is treated as empty (no throw)
//   - set() then remove() leaves the key absent
//
// For now this file is a placeholder so the test file count includes it and
// future maintainers see the gap.
describe.skip('main/SecureStore (Electron-only; see TODO)', () => {
  it('placeholder', () => {});
});
