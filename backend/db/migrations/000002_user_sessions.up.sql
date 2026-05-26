-- Per-user saved session — the set of servers the user has connected to,
-- the channels they're in on each, the active server + channel cursor.
-- Synced from the client's localStorage so reinstalling / switching devices
-- restores the same setup. Stored as JSONB so the schema can evolve in the
-- client without a migration round-trip for every shape change.

CREATE TABLE user_sessions (
    user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);
