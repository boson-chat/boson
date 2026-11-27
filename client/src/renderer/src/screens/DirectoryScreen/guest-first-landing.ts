// The chat side of guest-first entry (modules/guest/guest-first.ts): where
// a guest lands on the home network, and a fresh friendly nick when the
// one made for them is taken there.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AuthService } from '../../modules/auth';
import {
  consumeLinkChannel, friendlyNick, guestAutojoinChannels, guestFirstLink, guestFirstOn, guestNickIsAuto, guestNickStep,
  landingChannel, rememberGuestNick, takeGuestLanding, type GuestLanding,
} from '../../modules/guest/guest-first';
import { emitGuestChange, saveGuestSession } from '../../modules/guest/guest';
import type { HomeNetwork } from '../../modules/netauth/home-network';
import type { DirectoryBloc } from './DirectoryBloc';

// undefined: not known yet (wait); null: nothing to land on; else the
// landing. A guest just in from the entry has one (takeGuestLanding); a
// returning guest opening a ?channel= link gets that channel when the
// network lets guests join it. Self-hosted home networks only, once their
// IRC server is known.
export function useGuestFirstLanding(home: HomeNetwork, guestNick: string | null, auth: Pick<AuthService, 'config'> | null): GuestLanding | null | undefined {
  const [landing, setLanding] = useState<GuestLanding | null | undefined>(undefined);
  const ready = home.selfHosted ? !!home.irc?.host : true;
  useEffect(() => {
    if (!ready || landing !== undefined) return;
    if (!guestNick || !home.selfHosted) { setLanding(null); return; }
    const taken = takeGuestLanding();
    if (taken) { setLanding(taken); return; }
    const wanted = guestFirstLink().channel;
    if (!wanted || typeof auth?.config !== 'function') { setLanding(null); return; }
    let live = true;
    auth.config().then((cfg) => {
      if (!live) return;
      consumeLinkChannel();
      const ch = guestFirstOn(cfg) ? landingChannel(cfg, wanted) : null;
      setLanding(ch && ch.toLowerCase() === wanted.toLowerCase() ? { focus: ch, channels: guestAutojoinChannels(cfg) } : null);
    }, () => { if (live) setLanding(null); });
    return () => { live = false; };
  }, [ready, guestNick, home.selfHosted, auth, landing]);
  return landing;
}

const RETRY_GAP_MS = 2500;

// The guest's nick was made for them (friendlyNick) and the home network
// says it's taken (433: the connection registered as "ZestyKiwi_"): try
// fresh ones, a few times, and keep the first the network takes.
export function useGuestNickRetry(bloc: DirectoryBloc, home: HomeNetwork, guestNick: string | null): void {
  const memo = useRef<{ nick: string | null; tried: string[]; attempts: number; at: number }>({ nick: null, tried: [], attempts: 0, at: 0 });
  useEffect(() => {
    if (!guestNick || !home.selfHosted || !home.irc?.host) return;
    const host = home.irc.host.toLowerCase();
    const check = (): void => {
      const m = memo.current;
      if (m.nick !== guestNick && !m.tried.some((t) => t.toLowerCase() === guestNick.toLowerCase())) {
        memo.current = { nick: guestNick, tried: [], attempts: 0, at: 0 };
      }
      if (!guestNickIsAuto(guestNick)) return;
      const conn = bloc.getState().connections.find((c) => c.server.hostname.toLowerCase() === host && c.engineState === 'connected');
      if (!conn) return;
      const current = conn.chat.selfIdentity().nick;
      const step = guestNickStep({ guestNick, current, tried: memo.current.tried, attempts: memo.current.attempts });
      if (!step) return;
      if (step.kind === 'keep') {
        rememberGuestNick(step.nick, true);
        memo.current = { ...memo.current, nick: step.nick };
        saveGuestSession({ nick: step.nick });
        emitGuestChange();
        return;
      }
      if (Date.now() - memo.current.at < RETRY_GAP_MS) return;
      const next = friendlyNick(Math.random, memo.current.attempts + 1);
      memo.current = { ...memo.current, tried: [...memo.current.tried, next], attempts: memo.current.attempts + 1, at: Date.now() };
      conn.chat.changeNick(next, { remember: false });
    };
    check();
    const off = bloc.subscribe(() => check());
    const timer = setInterval(check, RETRY_GAP_MS);
    return () => { off(); clearInterval(timer); };
  }, [bloc, home, guestNick]);
}
