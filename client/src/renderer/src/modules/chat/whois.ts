import type { WhoisInfo } from './chat.types';

// The WHOIS replies a profile is built from. The engine forwards each as
// Args = the params after our own nick (Args[0] = the nick asked about) and
// Message = the trailing param.
//   301 RPL_AWAY            <nick> :<away message>
//   311 RPL_WHOISUSER       <nick> <user> <host> * :<realname>
//   312 RPL_WHOISSERVER     <nick> <server> :<server info>
//   313 RPL_WHOISOPERATOR   <nick> :is an IRC operator
//   317 RPL_WHOISIDLE       <nick> <idle secs> <signon> :seconds idle, signon time
//   318 RPL_ENDOFWHOIS      <nick> :End of /WHOIS list
//   319 RPL_WHOISCHANNELS   <nick> :@#a +#b #c   (may repeat)
//   330 RPL_WHOISACCOUNT    <nick> <account> :is logged in as
//   335 RPL_WHOISBOT        <nick> :is a bot
//   338 RPL_WHOISACTUALLY   <nick> [<user@host>] <ip> :actually using host
//   378 RPL_WHOISHOST       <nick> :is connecting from *@<host> <ip>
//   671 RPL_WHOISSECURE     <nick> :is using a secure connection
//   401 ERR_NOSUCHNICK      <nick> :No such nick/channel
export const WHOIS_REPLIES = new Set(['301', '311', '312', '313', '317', '318', '319', '330', '335', '338', '378', '671', '401']);

// Replies that also arrive outside a WHOIS (301 when you message someone
// away, 401 when they've gone): only taken while one is in flight.
export const WHOIS_ONLY_WHILE_LOADING = new Set(['301', '401']);

/** `prev` updated with one WHOIS reply. */
export function applyWhoisReply(prev: WhoisInfo, kind: string, args: readonly string[], message: string): WhoisInfo {
  const next: WhoisInfo = { ...prev };
  switch (kind) {
    case '301':
      next.away = message;
      break;
    case '311':
      if (args[1]) next.user = args[1];
      if (args[2]) next.host = args[2];
      next.realname = message;
      break;
    case '312':
      if (args[1]) next.server = args[1];
      if (message && message !== args[1]) next.serverInfo = message;
      break;
    case '313':
      next.oper = message || 'is an IRC operator';
      break;
    case '317': {
      const idle = Number(args[1]);
      if (Number.isFinite(idle)) next.idleSeconds = idle;
      // Older servers send only the idle time; the trailing text then sits
      // where the signon would be.
      const signon = args.length >= 4 ? Number(args[2]) : NaN;
      if (Number.isFinite(signon) && signon > 0) next.signonAt = signon * 1000;
      break;
    }
    case '318':
      next.loading = false;
      break;
    case '319': {
      const chans = message.split(/\s+/).filter(Boolean);
      next.channels = [...(prev.channels ?? []), ...chans.filter((c) => !prev.channels?.includes(c))];
      break;
    }
    case '330':
      if (args[1]) next.account = args[1];
      break;
    case '335':
      next.bot = true;
      break;
    case '338': {
      const shown = args.slice(1, -1).join(' ');
      if (shown) next.actualHost = shown;
      break;
    }
    case '378': {
      const shown = message.replace(/^is connecting from\s*/i, '').trim();
      if (shown) next.actualHost = shown;
      break;
    }
    case '671':
      next.secure = true;
      break;
    case '401':
      next.notFound = true;
      next.loading = false;
      break;
  }
  return next;
}

/** "nick!user@host", with `*` for what we don't know. */
export function formatMask(nick: string, user?: string, host?: string): string {
  return `${nick}!${user || '*'}@${host || '*'}`;
}
