// Memos are server-stored offline messages between IRC accounts,
// delivered via the MemoServ pseudo-user. Unlike DMs (which are
// transient channel messages between connected users), memos
// persist on the network until the recipient reads / deletes them.
//
// Boson abstracts them out of the per-server chat stream and into
// a unified cross-server Inbox so the user has one place to read
// everything they've received, regardless of which network it came
// from. This file defines the shared type surface; the actual
// storage + parsing lives in `memo.store.ts` + `memo.parse.ts`.

export interface Memo {
  // Stable per-entry id. Synthesised from `${serverId}:${timestamp}:${counter}`
  // so two memos that land in the same ms on the same connection still
  // get distinct ids.
  id: string;
  // Server connection the memo arrived on. Matches the `serverId` the
  // renderer mints at connect time.
  serverId: string;
  // Human-readable server name for display ("Libera", "Boson HQ").
  serverName: string;
  // Verbatim text of the MemoServ NOTICE. Sender parsing is best-effort
  // and lives in the inbox renderer; we don't normalise here because
  // Atheme + Anope use different banner formats.
  text: string;
  // Wall-clock arrival time on the renderer side. We don't trust the
  // server's date stamp inside the memo body — clock skew across
  // networks makes it unreliable for sort order.
  timestamp: number;
  // True until the user has opened the Inbox view since this memo
  // arrived. Drives the unread badge in the title bar.
  read: boolean;
}

export type MemoListener = (memos: ReadonlyArray<Memo>) => void;
