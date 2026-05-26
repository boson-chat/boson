// Tab-completion helpers for the chat input. Pure functions over the
// (value, cursor) shape; no DOM or bloc dependency.
import { NICK_CHAR_RE } from './chat-input.tokenize';

// Walk back from `cursor` over consecutive nick-legal chars and return the
// index where the word starts. Returns `cursor` itself when the char to
// the left of the cursor is not a nick char (i.e. no word to complete).
export function findNickWordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && NICK_CHAR_RE.test(value.charAt(i - 1))) i--;
  return i;
}

// IRC convention: addressing someone at the start of a line gets "nick: "
// so the recipient sees "alice: hi" — most clients also highlight that
// form. Mid-line completions just inject the bare nick.
export function formatNickCompletion(nick: string, atLineStart: boolean): string {
  return atLineStart ? `${nick}: ` : nick;
}
