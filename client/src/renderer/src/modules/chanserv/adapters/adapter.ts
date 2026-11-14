import type {
  AccessResult, ChanRole, ChanServCapabilities, ChanServDialect, ChanServResult, InfoResult, Operation,
} from '../chanserv.types';

// One services package's mapping of the UI's actions onto commands and reply
// parsers. Methods for actions the package lacks are absent (and the matching
// capability is off); callers check `caps` first.
export interface ChanServAdapter {
  readonly id: ChanServDialect;
  // How the UI names the package ("Anope", "Undernet X", …).
  readonly label: string;
  // The service's nick (ChanServ, or X / Q on ircu networks).
  readonly serviceNick: string;
  readonly caps: ChanServCapabilities;

  info(channel: string): Operation<InfoResult>;
  // Extra settings that INFO doesn't show (Ergo's history setting).
  readSettings?(channel: string): Operation<InfoResult>;
  register?(channel: string, description?: string): Operation<ChanServResult>;
  // `self` is our account: Atheme's handover drops our own founder flag.
  transfer?(channel: string, account: string, self: string): Operation<ChanServResult>;
  acceptTransfer?(channel: string): Operation<ChanServResult>;
  unregister?(channel: string): Operation<ChanServResult>;
  listAccess?(channel: string): Operation<AccessResult>;
  // Grant `role` to `account` (replacing what it had: `previous`), or remove
  // its grant when role is null.
  setAccess?(channel: string, account: string, role: ChanRole | null, previous?: ChanRole | null): Operation<ChanServResult>;
  setOption?(channel: string, option: string, value: boolean | string): Operation<ChanServResult>;

  // An unsolicited NOTICE offering us a channel ("You have been offered
  // ownership of #x …"): returns the channel.
  transferOffer?(line: string): string | null;
}
