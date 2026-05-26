// Word-boundary check for whether a free-text message contains a given IRC
// nick. We can't use `\b` because the regex word class doesn't cover IRC's
// nick-legal punctuation (`[]\\{}|^`), so we explicitly enumerate the
// chars that bracket a real nick.
//
// Shared between:
//   - the chat service (badge / mention count tracking)
//   - the message renderer (in-message mention highlighting)
// so the two definitions can't drift apart.

const NICK_BOUNDARY_CHARS = String.raw`A-Za-z0-9_\-\[\]\\{}|^\``;

export function containsNickMention(text: string, nick: string): boolean {
  if (!nick) return false;
  const re = new RegExp(
    `(?:^|[^${NICK_BOUNDARY_CHARS}])${escapeRegex(nick)}(?:[^${NICK_BOUNDARY_CHARS}]|$)`,
    'i',
  );
  return re.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
