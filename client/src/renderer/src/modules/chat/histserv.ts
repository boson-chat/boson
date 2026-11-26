// histserv.ts — Ergo's HistServ stand-ins for history events.
//
// A session without event-playback that asks Ergo for a channel's history
// gets its JOIN/PART/QUIT/KICK/NICK/TOPIC/MODE/TAGMSG items as PRIVMSGs from
// HistServ instead (irc/channel.go, replayHistoryItems):
//
//   %s sent a TAGMSG
//   %s joined the channel
//   %[1]s [account: %[2]s] joined the channel
//   %[1]s left the channel (%[2]s)
//   %[1]s kicked %[2]s (%[3]s)
//   %[1]s quit (%[2]s)
//   %[1]s changed nick to %[2]s
//   %[1]s set the channel topic to: %[2]s
//   %[1]s set channel modes: %[2]s
//
// They only repeat what Boson's own join/part/quit rows already show, so
// they're dropped from channel backlog, and were cleaned out of stored
// history once (see idb-chat-history.store.ts). A HistServ conversation the
// user opened themselves (a query to HistServ) is left alone.

export const HISTSERV = 'HistServ';

const REPLAY_FORMATS: readonly RegExp[] = [
  /^\S+ sent a TAGMSG$/,
  /^\S+ joined the channel$/,
  /^\S+ \[account: \S+\] joined the channel$/,
  /^\S+ left the channel \(.*\)$/s,
  /^\S+ kicked \S+ \(.*\)$/s,
  /^\S+ quit \(.*\)$/s,
  /^\S+ changed nick to \S+$/,
  /^\S+ set the channel topic to: .*$/s,
  /^\S+ set channel modes: .*$/s,
];

const isChannel = (name: string): boolean => /^[#&]/.test(name);

/** Whether text is one of HistServ's event-replay lines. */
export function isHistServReplayText(text: string): boolean {
  return REPLAY_FORMATS.some((re) => re.test(text));
}

/**
 * Whether a line from `from` in conversation `channel` is a HistServ
 * stand-in for a history event: from HistServ, in a channel (never the
 * HistServ query itself), in one of the replay formats.
 */
export function isHistServReplay(from: string, channel: string, text: string): boolean {
  return from.toLowerCase() === HISTSERV.toLowerCase() && isChannel(channel) && isHistServReplayText(text);
}
