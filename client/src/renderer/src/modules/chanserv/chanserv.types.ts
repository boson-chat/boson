// Types for the ChanServ adapter layer: one UI (channel registration, roles,
// protection options, ownership) over the different channel-services
// packages IRC networks run. Each package ("dialect") has an adapter in
// ./adapters that maps the UI's actions onto its commands and parses its
// replies; ./runner.ts sends them over plain IRC and collects the NOTICEs.

// The channel-services packages we recognise.
//   ergo    — Ergo's built-in ChanServ (AMODE, TRANSFER + accept, UNREGISTER code)
//   anope   — Anope 2.x ChanServ (XOP/ACCESS, SET FOUNDER, DROP #c #c)
//   atheme  — Atheme ChanServ (FLAGS, DROP with key) — Libera, OFTC-style networks
//   x       — Undernet's X (GNUworld cservice): read-only status
//   q       — QuakeNet's Q: no public channel info, the panel is hidden
//   generic — some other ChanServ (DALnet, unknown packages): read-only status
export type ChanServDialect = 'ergo' | 'anope' | 'atheme' | 'x' | 'q' | 'generic';

// Persistent channel roles, highest first. Same names (and order) the
// client's voice-channel locks use, so the UI reads the same everywhere.
export const CHAN_ROLES = ['founder', 'admin', 'op', 'halfop', 'voice'] as const;
export type ChanRole = typeof CHAN_ROLES[number];

// What ChanServ told us about a channel.
export interface ChannelRegistration {
  channel: string;
  registered: boolean;
  founder?: string;
  successor?: string;
  description?: string;
  // Times as the services package printed them. Formats differ per package
  // (RFC1123 on Ergo, strftime on Anope, "… (3d ago)" on Atheme), so they
  // are shown verbatim rather than re-parsed and mis-localised.
  registeredAt?: string;
  lastUsed?: string;
  // When the services package itself would drop the channel (Anope "Expires").
  expires?: string;
  // The channel was purged / closed by network staff: it can't be used.
  closed?: boolean;
  // ChanServ options that are on, by option id (see ChanServOption.id).
  // Undefined when the reply didn't show options (no access, or the package
  // keeps them elsewhere).
  options?: Record<string, boolean>;
  // Option values that aren't on/off (Ergo's history setting).
  values?: Record<string, string>;
}

// One persistent-role grant on a channel.
export interface AccessEntry {
  account: string;
  // null: an entry we can't map onto the role ladder (custom levels/flags).
  role: ChanRole | null;
  // The package's own label for it (e.g. "+o", "AOP", "+AFRefiorstv", "5").
  raw: string;
}

// Why an action failed, in terms the UI can explain in plain language
// (see ./messages.ts).
export type ChanServErrorCode =
  | 'not-logged-in'
  | 'not-confirmed'
  | 'limit-reached'
  | 'operator-only'
  | 'not-opped'
  | 'not-in-channel'
  | 'already-registered'
  | 'not-registered'
  | 'no-such-channel'
  | 'no-such-account'
  | 'access-denied'
  | 'disabled'
  | 'closed'
  | 'invalid'
  | 'unsupported'
  | 'unreadable'
  | 'timeout'
  | 'no-service'
  | 'busy'
  | 'failed';

export interface ChanServError {
  kind: 'error';
  code: ChanServErrorCode;
  // The service's own lines, for "show details" and for unknown failures.
  lines: string[];
}

export type ChanServDone = {
  kind: 'done';
  // pending: the server accepted it but someone else still has to act
  // (an Ergo transfer waits for the new founder to accept).
  pending?: boolean;
  // nochange: there was nothing to do (already set, already absent).
  nochange?: boolean;
  lines: string[];
};

export type ChanServResult = ChanServDone | ChanServError;

export type InfoResult = { kind: 'info'; info: ChannelRegistration; lines: string[] } | ChanServError;
export type AccessResult = { kind: 'access'; entries: AccessEntry[]; lines: string[] } | ChanServError;

// A ChanServ option the UI can toggle (or pick a value for).
export interface ChanServOption {
  id: string;
  label: string;
  hint: string;
  // Choice options (Ergo history) carry their values; absent → on/off.
  choices?: ReadonlyArray<{ value: string; label: string }>;
}

// What a dialect can do. The UI shows only what's here.
export interface ChanServCapabilities {
  info: boolean;
  register: boolean;
  // REGISTER takes an optional description (Anope).
  registerDescription: boolean;
  // How ownership moves:
  //   code-accept — Ergo: confirmation code, then the new founder accepts
  //   direct      — Anope SET FOUNDER: takes effect at once
  //   flags       — Atheme: give the new founder +F, then drop your own +F
  transfer: 'code-accept' | 'direct' | 'flags' | null;
  unregister: boolean;
  access: boolean;
  // Roles that can be granted persistently, highest first.
  roles: ReadonlyArray<ChanRole>;
  options: ReadonlyArray<ChanServOption>;
}

// ---- Operations -----------------------------------------------------------
//
// An operation is a pure description of one ChanServ exchange: the first
// command to send and a classifier over the reply lines collected so far.
// The runner sends `first`, feeds every ChanServ NOTICE into `step`, and
// stops on a final verdict. Multi-step flows (confirmation codes, keys)
// return `{ send }` to fire a follow-up; the collected lines reset.
//
// `settled` is true once the service has gone quiet: the classifier must
// return a final verdict then, and an operation that recognised nothing
// returns an `unreadable` error — never a guessed success.
export type Verdict<T> =
  | { final: T }
  | { send: string }
  | null;

export interface Operation<T> {
  first: string;
  step(lines: readonly string[], settled: boolean): Verdict<T>;
  // At most this many follow-ups (guards against a reply loop). Default 2.
  maxFollowUps?: number;
}
