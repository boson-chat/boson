import { HttpError } from '../../shared/http/http.client';

// The backend's answer to POST /me/nick-claims while the network admin has
// nick claims turned off: 403 {"error":"nick_claim_disabled"}.
export const NICK_CLAIM_DISABLED = 'nick_claim_disabled';

export function isNickClaimDisabledError(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 403) return false;
  const body = err.body;
  return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === NICK_CLAIM_DISABLED;
}
