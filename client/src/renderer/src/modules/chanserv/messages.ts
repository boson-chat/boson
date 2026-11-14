// Plain-language explanations for ChanServ failures.
import type { ChanServErrorCode } from './chanserv.types';

const MESSAGES: Record<ChanServErrorCode, string> = {
  'not-logged-in': 'Sign in to an account first. Channels are registered to accounts, so guests can\'t register or manage them.',
  'not-confirmed': 'Confirm your account\'s email address first, then try again.',
  'limit-reached': 'You\'ve registered as many channels as this server allows. Unregister one you no longer need, then try again.',
  'operator-only': 'Only server staff can register channels on this server.',
  'not-opped': 'You need to be a channel operator (@) here to register it.',
  'not-in-channel': 'Join the channel first, then register it.',
  'already-registered': 'This channel is already registered.',
  'not-registered': 'This channel isn\'t registered.',
  'no-such-channel': 'The channel doesn\'t exist right now. Someone has to be in it to register it.',
  'no-such-account': 'There\'s no account with that name. Use their account name, which can differ from their nick.',
  'access-denied': 'You don\'t have permission to do that in this channel.',
  'disabled': 'Channel registration is turned off on this server.',
  'closed': 'This channel was closed by network staff.',
  'invalid': 'ChanServ didn\'t accept that. Check the name and try again.',
  'unsupported': 'This server\'s ChanServ doesn\'t support that.',
  'unreadable': 'Couldn\'t read ChanServ\'s reply.',
  'timeout': 'ChanServ didn\'t answer. Try again in a moment.',
  'no-service': 'This server has no ChanServ.',
  'busy': 'ChanServ is busy. Try again in a moment.',
  'failed': 'ChanServ couldn\'t do that.',
};

export function chanServErrorText(code: ChanServErrorCode): string {
  return MESSAGES[code];
}
