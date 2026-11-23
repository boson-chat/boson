// The auth service's error messages are lower-case fragments ("password must
// be at least 10 characters"); these turn them into the app's sentences.

// The auth service's password complaint, in the form's words.
export function friendlyPasswordError(message: string): string {
  const min = /at least (\d+)/i.exec(message);
  if (min) return `Use at least ${min[1]} characters.`;
  const max = /at most (\d+)/i.exec(message);
  if (max) return `Use at most ${max[1]} characters.`;
  if (/username or email/i.test(message)) return "Pick a password that isn't your username or email.";
  return sentence(message);
}

// "password must be …" → "Password must be ….": server wording is lower-case
// fragments.
export function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const cap = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}
