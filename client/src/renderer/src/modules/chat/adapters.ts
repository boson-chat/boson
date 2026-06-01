// Per-package adapters for the differences between Atheme, Anope, and
// Ergo NickServ command surfaces.
//
// **Status (post AccountService migration, Steps 2–8):** The
// caller-facing surface for REGISTER / IDENTIFY / CONFIRM / DROP /
// RESEND has moved to [`AccountService`](./account-service.ts) —
// each impl owns its full multi-step dance, returns a discrete
// result kind, and the UI never builds raw IRC strings. The `build*`
// methods for those operations have been removed.
//
// What remains here:
//   * `buildInfo(accountName)` — the only operation still using the
//     fire-and-forget legacy path (no AccountService.info() yet;
//     the existing "Check status" button shows the raw NickServ
//     reply in the server tab, which is the right level of detail
//     for a diagnostic command). Once Phase 5 (automated
//     registration) needs a parsed AccountInfo struct, this
//     migrates too and the whole file can be deleted.
//   * `getAdapter(framework)` — selector so callers can pick the
//     right impl without a switch statement.
//
// Reference: `.claude/skills/boson-irc-cmd/SKILL.md` carries the
// full per-framework reply matrix + the source-of-truth citations
// for each command shape.

import type { ServicesFramework } from './services';

// What every adapter must provide. Caller code (the Identity panel's
// "Check status" button, for now) only sees this interface — the
// concrete adapter is selected by `getAdapter(framework)`.
export interface ServicesAdapter {
  readonly id: 'anope' | 'atheme' | 'ergo';

  // Probe the account state. `INFO <nick>` is portable across all
  // three packages and returns a multi-line block including
  // identification state + email-confirmation state.
  buildInfo(accountName: string): string;
}

// ---- Anope ----------------------------------------------------------------
// Sources: anope/modules/commands/ns_info.cpp.
export class AnopeAdapter implements ServicesAdapter {
  readonly id = 'anope';
  buildInfo(accountName: string): string {
    return `/msg NickServ INFO ${accountName}`;
  }
}

// ---- Atheme ---------------------------------------------------------------
// Sources: atheme/modules/nickserv/info.c.
export class AthemeAdapter implements ServicesAdapter {
  readonly id = 'atheme';
  buildInfo(accountName: string): string {
    return `/msg NickServ INFO ${accountName}`;
  }
}

// ---- Ergo -----------------------------------------------------------------
// Sources: ergo/irc/nickserv.go.
export class ErgoAdapter implements ServicesAdapter {
  readonly id = 'ergo';
  buildInfo(accountName: string): string {
    return `/msg NickServ INFO ${accountName}`;
  }
}

// Selector. Unknown/null framework falls back to Anope-shaped because
// Anope is the most common deployment on UnrealIRCd-style networks
// (which is also what irc.boson.chat runs). Atheme networks identify
// themselves quickly via their VERSION/banner so the detector flips
// before any real command is sent.
export function getAdapter(framework: ServicesFramework | null | undefined): ServicesAdapter {
  switch (framework) {
    case 'atheme': return new AthemeAdapter();
    case 'ergo':   return new ErgoAdapter();
    case 'anope':
    case 'unknown':
    case null:
    case undefined:
    default:       return new AnopeAdapter();
  }
}
