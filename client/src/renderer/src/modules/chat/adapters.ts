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

  // How operator access is granted on this package:
  //   'live'   — runtime services command (Anope OperServ OPER), so the
  //              client can manage the oper list directly.
  //   'config' — no runtime grant; opers come from a config block the
  //              owner pastes + rehashes (Atheme operator{}, Ergo opers:).
  readonly operMode: 'live' | 'config';

  // Probe the account state. `INFO <nick>` is portable across all
  // three packages and returns a multi-line block including
  // identification state + email-confirmation state.
  buildInfo(accountName: string): string;

  // ---- Oper management ----------------------------------------------------
  // Live adapters (Anope) implement the three OperServ OPER verbs; config
  // adapters (Atheme/Ergo) implement buildOperConfig instead. The Operators
  // UI branches on `operMode` and calls only the relevant set.

  // Live: add/remove/list service operators by account. `type` is the
  // deployment-defined oper type/operclass name.
  buildOperAdd?(account: string, type: string): string;
  buildOperDel?(account: string): string;
  buildOperList?(): string;

  // Config: a paste-ready operator block granting `account` the named
  // type/operclass. Returned verbatim for the owner to copy into the
  // services/ircd config and rehash.
  buildOperConfig?(account: string, type: string): string;
}

// ---- Anope ----------------------------------------------------------------
// Sources: anope/modules/commands/ns_info.cpp.
export class AnopeAdapter implements ServicesAdapter {
  readonly id = 'anope';
  readonly operMode = 'live' as const;
  buildInfo(accountName: string): string {
    return `/msg NickServ INFO ${accountName}`;
  }
  // OperServ OPER ADD/DEL/LIST — runtime, account-based, persisted by Anope.
  // An added account is auto-granted services-oper when it identifies, so a
  // Boson member opers with no password. Source: anope/modules/operserv/os_oper.cpp.
  buildOperAdd(account: string, type: string): string {
    return `/msg OperServ OPER ADD ${account} ${type}`;
  }
  buildOperDel(account: string): string {
    return `/msg OperServ OPER DEL ${account}`;
  }
  buildOperList(): string {
    return `/msg OperServ OPER LIST`;
  }
}

// ---- Atheme ---------------------------------------------------------------
// Sources: atheme/modules/nickserv/info.c.
export class AthemeAdapter implements ServicesAdapter {
  readonly id = 'atheme';
  readonly operMode = 'config' as const;
  buildInfo(accountName: string): string {
    return `/msg NickServ INFO ${accountName}`;
  }
  // Atheme has no runtime oper-grant command — operators are defined by an
  // operator{} block keyed on the account name, with privileges from a named
  // operclass. The owner pastes this into atheme.conf and rehashes.
  // Source: atheme doc/operator-classes, conf/atheme.conf.example.
  buildOperConfig(account: string, type: string): string {
    return `operator "${account}" {\n\toperclass = "${type}";\n};`;
  }
}

// ---- Ergo -----------------------------------------------------------------
// Sources: ergo/irc/nickserv.go.
export class ErgoAdapter implements ServicesAdapter {
  readonly id = 'ergo';
  readonly operMode = 'config' as const;
  buildInfo(accountName: string): string {
    return `/msg NickServ INFO ${accountName}`;
  }
  // Ergo defines opers in the ircd.yaml `opers:` block. There is no runtime
  // grant; the owner pastes this entry under `opers:` and rehashes. `type`
  // names an entry from the `oper-classes:` block. Source: ergo default.yaml.
  buildOperConfig(account: string, type: string): string {
    return `opers:\n    "${account}":\n        class: "${type}"\n        # set a password hash with: ergo genpasswd\n        password: ""`;
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
