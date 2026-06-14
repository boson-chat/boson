-- Per-user GLOBAL end-to-end-encrypted bouncer (ZNC/BNC) profile. The client
-- encrypts {enabled, host, port, tls, tlsInsecure, username, password} under a
-- key derived from its user_secret ("bouncer-profile-v1") and uploads only the
-- opaque ciphertext, so the profile follows the user across devices. One row
-- per user (PK = user_id); the password lives ONLY inside the blob — the
-- server can't decrypt it.
CREATE TABLE bouncer_secret (
    user_id    uuid NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ciphertext bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
