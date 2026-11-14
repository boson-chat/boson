import { describe, it, expect } from 'vitest';
import { HttpError } from '../../shared/http/http.client';
import { isNickClaimDisabledError } from './nick-claim';

describe('isNickClaimDisabledError', () => {
  it('matches only 403 {"error":"nick_claim_disabled"}', () => {
    expect(isNickClaimDisabledError(new HttpError(403, 'nick_claim_disabled', { error: 'nick_claim_disabled' }))).toBe(true);
    expect(isNickClaimDisabledError(new HttpError(403, 'forbidden', { error: 'forbidden' }))).toBe(false);
    expect(isNickClaimDisabledError(new HttpError(429, 'nick_claim_disabled', { error: 'nick_claim_disabled' }))).toBe(false);
    expect(isNickClaimDisabledError(new HttpError(403, 'nick_claim_disabled', 'nick_claim_disabled'))).toBe(false);
    expect(isNickClaimDisabledError(new Error('nick_claim_disabled'))).toBe(false);
    expect(isNickClaimDisabledError(null)).toBe(false);
  });
});
