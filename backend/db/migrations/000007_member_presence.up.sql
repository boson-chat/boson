-- A signed-in Boson client publishes its own IRC identity per network here
-- (current nick + host + services account). Other clients query this table
-- to detect which users they see in a channel are Boson members, so they can
-- show their profile image. One row per (user, network) — last write wins.
-- ON DELETE CASCADE clears presence when the account is deleted (DELETE /me).
CREATE TABLE member_presence (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    network    text NOT NULL,
    nick       text NOT NULL,
    host       text,
    account    text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, network)
);

-- Lookups match on network + the strong key (account) or the fallback key
-- (lowercased nick + host); index both paths.
CREATE INDEX member_presence_account_idx
    ON member_presence (network, lower(account))
    WHERE account IS NOT NULL AND account <> '';
CREATE INDEX member_presence_nickhost_idx
    ON member_presence (network, lower(nick), host);
