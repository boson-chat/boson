// Username rules of the auth service (its internal/nick package): usernames
// are IRC nicks. Checked here for instant feedback; the service has the
// final say (and also rejects names already taken).

const MAX_LEN = 30;
const SPECIAL = '[]\\`_^{|}';
const RESERVED = new Set([
  'nickserv', 'chanserv', 'memoserv', 'operserv', 'hostserv', 'botserv',
  'global', 'services', 'statserv', 'helpserv', 'saslserv', 'irc', 'server', 'root',
]);

const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c: string) => c >= '0' && c <= '9';
const isSpecial = (c: string) => SPECIAL.includes(c);

// null when valid, else a sentence saying what's wrong.
export function validateUsername(name: string): string | null {
  if (name === '') return 'Pick a username.';
  if (name.length > MAX_LEN) return `At most ${MAX_LEN} characters.`;
  const first = name[0]!;
  if (!isLetter(first) && !isSpecial(first)) return 'Start with a letter (or one of [ ] \\ ` _ ^ { | }).';
  for (const c of name.slice(1)) {
    if (!isLetter(c) && !isDigit(c) && !isSpecial(c) && c !== '-') {
      return c === ' ' ? 'No spaces.' : `“${c}” isn't allowed: letters, digits and - [ ] \\ \` _ ^ { | } only.`;
    }
  }
  if (RESERVED.has(name.toLowerCase())) return 'That name is reserved.';
  return null;
}

// The Boson handle: the user's name across Boson and their IRC nick, so the
// same rules as a username, and at least 3 characters (the API's minimum;
// the API itself only checks the length).
export function validateHandle(handle: string): string | null {
  if (handle.length < 3) return 'Handle must be at least 3 characters.';
  return validateUsername(handle);
}
