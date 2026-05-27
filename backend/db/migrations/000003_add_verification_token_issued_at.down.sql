DROP INDEX IF EXISTS servers_verification_token_issued_at_idx;

ALTER TABLE servers
    DROP COLUMN IF EXISTS verification_token_issued_at;
