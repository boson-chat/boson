// Pure tokenization helpers shared by the chat input view and the
// ChatInputBloc. Lives in its own module so the bloc never has to import
// from ChatArea.tsx (which would create a view <-> bloc circular import).

// IRC nick chars per RFC 2812 — letters, digits, `_-[]\{}|^\``.
// Used as a single-char predicate (e.g. for walking back from the cursor
// to find the start of a nick word).
export const NICK_CHAR_RE = /[A-Za-z0-9_\-[\]\\{}|^`]/;

// Same character set as NICK_CHAR_RE but encoded as a string body that can
// be interpolated into a custom regex character class. We can't just use
// `\b` for nick-mention boundaries because IRC nick chars (`[]\\{}|^`)
// aren't in JavaScript's \w word class.
export const NICK_BOUNDARY_CHARS = String.raw`A-Za-z0-9_\-\[\]\\{}|^\``;

// Tokenize the input for overlay rendering. Returns an ordered list of
// styled segments. The overlay paints them; the (transparent) textarea
// remains the actual edit surface.
export type InputTokenKind = 'text' | 'mention' | 'channel' | 'command';
export interface InputToken {
  type: InputTokenKind;
  value: string;
}

export function tokenizeInput(input: string, members: { nick: string }[]): InputToken[] {
  if (!input) return [];
  const memberSet = new Set(members.map((m) => m.nick.toLowerCase()));
  const tokens: InputToken[] = [];

  // Strip off a leading slash command. '//' is the escape for a literal '/'
  // and isn't colorized as a command.
  let rest = input;
  if (input.startsWith('/') && !input.startsWith('//')) {
    const cmdMatch = /^\/[A-Za-z]+/.exec(input);
    if (cmdMatch) {
      tokens.push({ type: 'command', value: cmdMatch[0] });
      rest = input.slice(cmdMatch[0].length);
    }
  }

  // Walk the rest, picking out @mentions and #channels (only at word
  // boundaries — start of line or after whitespace).
  const re = /(?<=^|\s)(@[A-Za-z0-9_\-[\]\\{}|^`]+)|(?<=^|\s)([#&][A-Za-z0-9_\-[\]\\{}|^`]+)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    if (m.index > lastIdx) {
      tokens.push({ type: 'text', value: rest.slice(lastIdx, m.index) });
    }
    if (m[1]) {
      const nick = m[1].slice(1).toLowerCase();
      tokens.push({ type: memberSet.has(nick) ? 'mention' : 'text', value: m[1] });
    } else if (m[2]) {
      tokens.push({ type: 'channel', value: m[2] });
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < rest.length) {
    tokens.push({ type: 'text', value: rest.slice(lastIdx) });
  }
  return tokens;
}

// On send, rewrite "@nick" to "nick" when nick is a known channel member.
// Unknown @ patterns (emails, bot triggers like "@!somebot") are left alone.
export function stripMentionAts(text: string, members: { nick: string }[]): string {
  if (members.length === 0) return text;
  const lookup = new Map(members.map((m) => [m.nick.toLowerCase(), m.nick]));
  return text.replace(
    /(^|\s)@([A-Za-z0-9_\-[\]\\{}|^`]+)/g,
    (full, lead: string, nickPart: string) => {
      const known = lookup.get(nickPart.toLowerCase());
      return known ? `${lead}${known}` : full;
    },
  );
}
