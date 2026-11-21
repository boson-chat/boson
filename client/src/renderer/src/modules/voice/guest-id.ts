// Guest voice: the random id a guest's voice tokens carry (sub
// "guest:<id>"), one per auth service, kept in localStorage so the voice
// server (and other people's per-user volumes) see the same guest across
// calls and runs. Not a secret: anyone may claim any guest id, the nick is
// unverified either way, and the token is only good for voice.

const PREFIX = 'boson.voice.guestId:';
// 16–64 chars of [A-Za-z0-9_-] (the auth service's rule).
const VALID = /^[A-Za-z0-9_-]{16,64}$/;

type Local = Pick<Storage, 'getItem' | 'setItem'>;

function defaultLocal(): Local | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

// 24 random bytes, base64url: 32 characters.
export function newGuestVoiceId(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The guest id for authUrl (normalized by the caller), made and saved on
// first use. Without storage it lasts the run (memo).
const memo = new Map<string, string>();

export function guestVoiceId(authUrl: string, local: Local | null = defaultLocal()): string {
  const key = PREFIX + authUrl;
  try {
    const saved = local?.getItem(key);
    if (saved && VALID.test(saved)) return saved;
  } catch { /* storage off */ }
  const id = memo.get(key) ?? newGuestVoiceId();
  memo.set(key, id);
  try { local?.setItem(key, id); } catch { /* storage off */ }
  return id;
}

// Whether a voice participant joined as a guest (no account): the voice
// server's flag, or a guest token's user id.
// Sign-out: a new guest id next time (the storage wipe removes the saved ones).
export function clearGuestVoiceIdsForSignOut(): void {
  memo.clear();
}

export function isGuestParticipant(p: { guest?: boolean; userId?: string } | null | undefined): boolean {
  return !!p && (p.guest === true || (p.userId ?? '').startsWith('guest:'));
}
