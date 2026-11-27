import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { Dices } from 'lucide-preact';
import { Button, Card, Field, Input } from '@boson/shared';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import { friendlyNick, lastGuestNick } from '../../modules/guest/guest-first';

// The guest-first entry (modules/guest/guest-first.ts): a ready nick, one
// "Join chat" button, and sign-in / sign-up a click away.
export function GuestFirstEntry({ name, channel, logo, backdrop, initialNick, autoJoin, canSignUp, onJoin, onSignIn, onSignUp }: {
  // The network's name.
  name: string;
  // Where joining lands (null: the network's default).
  channel: string | null;
  // The network's logo (its branding), else null: its name is the title.
  logo: ComponentChildren | null;
  backdrop: { class: string; style?: JSX.CSSProperties };
  // ?nick= from the link (else the one kept on this device, else a new one).
  initialNick: string | null;
  // ?join=1: join at once, without the click.
  autoJoin: boolean;
  canSignUp: boolean;
  // nick, and whether it's the one made for the visitor (untouched).
  onJoin: (nick: string, auto: boolean) => void;
  onSignIn: () => void;
  onSignUp: () => void;
}) {
  const [made] = useState(() => {
    if (initialNick) return { nick: initialNick, auto: false };
    const last = lastGuestNick();
    return last ?? { nick: friendlyNick(), auto: true };
  });
  const [nick, setNick] = useState(made.nick);
  const [auto, setAuto] = useState(made.auto);
  const trimmed = nick.trim();
  const clean = trimmed ? sanitizeIrcNick(trimmed) : '';
  const problem = !trimmed
    ? null
    : clean !== trimmed
      ? `Nicknames use letters, digits and - _ [ ] { } | ^ \` \\, start with a letter, and are up to 16 characters. Try “${clean}”.`
      : null;

  const join = (e?: Event): void => {
    e?.preventDefault();
    if (!clean || problem) return;
    onJoin(clean, auto);
  };

  // ?join=1: straight in (once).
  const joined = useRef(false);
  useEffect(() => {
    if (!autoJoin || joined.current || !clean || problem) return;
    joined.current = true;
    onJoin(clean, auto);
  }, [autoJoin]);

  const where = channel ?? name;
  return (
    <div {...backdrop}>
      <div class="login-container guest-first">
        {logo ?? <h1 class="guest-first-network">{name}</h1>}
        <Card>
          <form class="guest-first-form" onSubmit={join} aria-label={`Join ${where}`}>
            <h2 class="guest-first-title">Join the chat</h2>
            <p class="guest-first-lede">
              Pick a nickname and you're in <strong class="guest-first-where">{where}</strong>. No account needed.
            </p>
            <Field label="Nickname" error={problem ?? undefined}>
              <div class="guest-first-nick">
                <Input
                  aria-label="Nickname"
                  value={nick}
                  onInput={(e) => { setNick((e.target as HTMLInputElement).value); setAuto(false); }}
                  invalid={!!problem}
                  maxLength={32}
                  required
                  autoComplete="nickname"
                  autoCapitalize="off"
                  spellcheck={false}
                />
                <Button
                  type="button"
                  variant="secondary"
                  icon={<Dices size={16} aria-hidden="true" />}
                  aria-label="Another nickname"
                  title="Another nickname"
                  onClick={() => { setNick(friendlyNick()); setAuto(true); }}
                />
              </div>
            </Field>
            <Button type="submit" variant="primary" size="lg" fullWidth disabled={!clean || !!problem}>
              Join chat
            </Button>
          </form>
        </Card>
        <p class="guest-first-account">
          <span>Have an account?</span>
          <Button variant="ghost" size="sm" onClick={onSignIn}>Sign in</Button>
          {canSignUp && (
            <>
              <span aria-hidden="true">·</span>
              <Button variant="ghost" size="sm" onClick={onSignUp}>Create an account</Button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
