-- Maps the auth service's user ids (the access token's `sub`, usr_<ULID>)
-- to boson's own user ids (users.id and every user_id column).
--
-- Accounts migrated from Supabase keep their old uuid: the import tool
-- (`server import-supabase-users`) writes one row per imported account, so
-- users, servers, sessions and secrets that already reference that uuid
-- keep resolving. Accounts created on the auth service later get a row on
-- their first authenticated request, with a uuid derived from the sub
-- (UUIDv5, so it can never equal a Supabase v4 id).
--
-- No foreign key to users: the mapping exists before (and independently of)
-- the profile row that POST /me creates, and survives DELETE /me so a
-- re-created profile lands on the same uuid.
CREATE TABLE auth_identities (
    auth_user_id text PRIMARY KEY,
    user_id      uuid NOT NULL UNIQUE,
    -- 'supabase_import' (written by the import tool) or 'auto' (first login).
    source       text NOT NULL DEFAULT 'auto' CHECK (source IN ('supabase_import', 'auto')),
    created_at   timestamptz NOT NULL DEFAULT now()
);
