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

// What kind of 1:1 traffic an Inbox entry represents:
//   memo    — a MemoServ offline memo (the original Inbox use case).
//   service — any other service pseudo-user (NickServ, ChanServ, Global,
//             …). Routed here AND hidden from the chat stream.
//   dm      — a direct message from a real user. Also shown as a normal
//             chat conversation; mirrored here so the Inbox is the one
//             place to see everything addressed to you.
export type MemoKind = 'memo' | 'service' | 'dm';

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
  // Who it's from — the IRC nick ("MemoServ", "NickServ", "alice").
  sender: string;
  // Which kind of 1:1 entry this is — drives the Inbox label/grouping.
  kind: MemoKind;
  // Verbatim text of the message/notice body. Sender lives in `sender`;
  // we don't normalise the body (Atheme + Anope memo banners differ).
  text: string;
  // Wall-clock arrival time on the renderer side. We don't trust the
  // server's date stamp inside the memo body — clock skew across
  // networks makes it unreliable for sort order.
  timestamp: number;
  // True until the user has opened the Inbox view since this memo
  // arrived. Drives the unread badge in the title bar.
  read: boolean;
  // ---- MemoServ-structured fields (kind === 'memo' only) ----------
  // The service-assigned index (the argument to `READ <n>` / `DEL <n>`).
  // Captured from LIST and refreshed on every LIST since indices shift
  // as memos are deleted. Used to lazily fetch the body on open.
  memoIndex?: number;
  // The memo's absolute send date as the service reported it (relative
  // "(N seconds ago)" suffix stripped so it stays stable across LISTs
  // and can serve as part of the dedup key). Display + dedup.
  memoDate?: string;
  // For LIST-sourced memos the body isn't known until the user opens
  // the entry (we deliberately defer `READ` so the memo stays unread on
  // the server — see the MemoServ flow in chat.service.ts). false ⇒
  // `text` is empty and the UI shows a "click to read" affordance;
  // true ⇒ `text` holds the fetched body.
  bodyFetched?: boolean;
}

export type MemoListener = (memos: ReadonlyArray<Memo>) => void;
