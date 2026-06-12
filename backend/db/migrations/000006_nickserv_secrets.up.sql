-- Per-(user, server) end-to-end-encrypted NickServ password. The client
-- encrypts {nickservPassword, accountName} under a key derived from its
-- user_secret (HMAC-SHA256, "nickserv-creds-v1"||server_id) and uploads the
-- opaque ciphertext here. The server stores it as bytea and can never decrypt
-- it. ON DELETE CASCADE means the "start over" account-delete path (DELETE /me)
-- also clears synced secrets.
CREATE TABLE nickserv_secrets (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id  text NOT NULL,
    ciphertext bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, server_id)
);
