-- nick_claims tracks an in-flight "claim a NickServ account on an IRC
-- network" operation for a signed-in Boson user. The backend mints
-- a row, returns an email address that includes the row's
-- short_token in the local part, and the IMAP worker captures the
-- confirmation code from incoming mail at that address.
--
-- Lifecycle:
--   pending   — row created, NickServ has not yet emailed the code
--   captured  — IMAP worker stored the code, awaiting client poll
--   consumed  — client polled, received the code, and is firing CONFIRM
--   expired   — TTL passed without a code arriving (or after consume)
--
-- TTL is 30 minutes from creation. The sweeper goroutine moves stale
-- pending rows to expired in batches; consumed rows are kept for
-- audit until a separate retention sweep deletes them (out of scope
-- here — for now they live forever).

CREATE TABLE nick_claims (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 8-char [a-z0-9] discriminator embedded in the recipient
    -- address. Worth keeping out of the URL path even when the
    -- handler scopes by user_id, since an attacker who could enumerate
    -- short_tokens would also have to forge the IMAP worker's flow to
    -- exploit them — defence in depth.
    short_token   text NOT NULL UNIQUE,
    -- IRC network identifier — opaque text. Today the client passes
    -- whatever its local serverId is; the backend doesn't validate.
    server_id     text NOT NULL,
    account_nick  text NOT NULL,
    status        text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'captured', 'consumed', 'expired')),
    code          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz,
    -- POP3 UIDL the worker captured this code from. Stored as an
    -- audit trail + a defence-in-depth dedupe signal (if a worker
    -- crashes between MarkCaptured and DELE, the same message
    -- arrives again on next session; the short_token lookup +
    -- ErrStaleStatus on duplicate MarkCaptured handle it cleanly,
    -- and the stored UIDL lets us correlate to the original
    -- capture in the logs).
    mail_uid      text
);

-- Worker lookup path — every incoming email turns into a single
-- FindByShortToken hit.
-- UNIQUE constraint on short_token (above) already creates this.

-- "Show me this user's in-flight claims" + handler-side rate-limit
-- query (count of created_at within an hour window).
CREATE INDEX nick_claims_user_status_idx
    ON nick_claims (user_id, status);

-- Partial index speeds up the TTL sweeper: only pending rows need
-- the expires_at scan; captured/consumed/expired rows are skipped.
CREATE INDEX nick_claims_pending_expires_idx
    ON nick_claims (expires_at)
    WHERE status = 'pending';
