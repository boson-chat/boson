// Convert a Boson handle (often an email) into a valid IRC nickname.
//
// IRC nicks (RFC 2812 §2.3.1, relaxed by most modern servers) must start
// with a letter or one of `[\]^_{}|` and may contain letters, digits, and
// `[\]^_{}|\`-`. The leading character cannot be a digit or a hyphen. Most
// networks cap length at 16 (libera) — we use 16 as a safe default.
//
// Behaviour:
//   - Replace each invalid character with `_`.
//   - If the first character would be a digit or hyphen, prepend `_`.
//   - Collapse runs of underscores to a single `_`.
//   - Trim trailing underscores.
//   - Truncate to `maxLen` (default 16).
//   - If the input is empty / all-invalid, fall back to `user`.
//
// Examples:
//   sanitizeIrcNick("james.trotter@joingotu.com") -> "james_trotter_jo"
//   sanitizeIrcNick("alice")                       -> "alice"
//   sanitizeIrcNick("9bob")                        -> "_9bob"
//   sanitizeIrcNick("")                            -> "user"

export function sanitizeIrcNick(raw: string, maxLen = 16): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9[\]\\^_`{}|\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/_+$/g, '');
  if (cleaned.length === 0) return 'user';
  const head = /^[A-Za-z[\]\\^_`{}|]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return head.slice(0, maxLen);
}
