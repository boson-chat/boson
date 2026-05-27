-- Track when the current verification_token was minted so we can enforce a
-- 72h TTL on tokens that have never been verified. Pre-existing rows that
-- predate the verify-endpoint feature keep their token but get NOW() as the
-- issuance time so they have a fresh window to complete verification.

ALTER TABLE servers
    ADD COLUMN verification_token_issued_at timestamptz;

UPDATE servers
   SET verification_token_issued_at = COALESCE(registered_at, now())
 WHERE verification_token_issued_at IS NULL
   AND verification_token IS NOT NULL;

-- Backfill a token for any historic row that somehow has none — the new
-- /verify endpoint will refuse to operate on a row without a token.
UPDATE servers
   SET verification_token            = encode(gen_random_bytes(32), 'base64'),
       verification_token_issued_at  = now()
 WHERE verification_token IS NULL;

CREATE INDEX servers_verification_token_issued_at_idx
    ON servers (verification_token_issued_at)
    WHERE verification_status = 'pending';
