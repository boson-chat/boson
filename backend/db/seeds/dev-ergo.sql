-- Dev-only seed: inserts the local ergo IRCd into the server directory so a
-- developer running `make ergo-up` can see it listed in Boson's directory
-- without manually adding it from the UI.
--
-- Applied by `make seed-dev` (called from `make dev-up`). Not embedded in the
-- migration set on purpose — this entry shouldn't ship to production.
--
-- Idempotent: ON CONFLICT DO UPDATE keeps the seed editable. The fixed UUID
-- (`...e8c0`) means re-running this script always updates the same row.

INSERT INTO servers (
    id, hostname, port, tls, name, description,
    tags, languages, is_nsfw, is_featured,
    verification_status, health_status
)
VALUES (
    '00000000-0000-0000-0000-00000000e8c0',
    'localhost',
    6667,
    false,
    'Local Ergo',
    'Local ergo IRCd for dev / testing. IRCv3 message-tags + server-time enabled — use this to verify typing indicators.',
    ARRAY['dev', 'local', 'ircv3', 'testing'],
    ARRAY['en'],
    false,
    true,
    'verified',
    'up'
)
ON CONFLICT (id) DO UPDATE
SET hostname = EXCLUDED.hostname,
    port = EXCLUDED.port,
    tls = EXCLUDED.tls,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    tags = EXCLUDED.tags,
    languages = EXCLUDED.languages,
    is_featured = EXCLUDED.is_featured,
    verification_status = EXCLUDED.verification_status,
    health_status = EXCLUDED.health_status;
