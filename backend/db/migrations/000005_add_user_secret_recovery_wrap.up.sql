-- Second, independent wrap of the user_secret, keyed by a one-time recovery
-- code (KEK = Argon2id(recovery_code)). Lets a user who forgot their login
-- password still unlock the same user_secret. Server stores only the opaque
-- blob and can decrypt neither wrap. Nullable: existing users have only the
-- password wrap until they enroll a recovery code.
ALTER TABLE users ADD COLUMN encrypted_user_secret_recovery bytea;
