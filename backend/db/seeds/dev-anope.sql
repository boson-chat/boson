-- Dev-only seed: inserts the e2e Anope+UnrealIRCd stack into the server
-- directory so the Playwright nickserv-flow spec can find + connect to
-- it. Applied by `make test-e2e-services-anope` after the docker
-- profile comes up. Not part of the migration set — never ships to
-- production.
--
-- Idempotent via fixed UUID + ON CONFLICT DO UPDATE.

INSERT INTO servers (
    id, hostname, port, tls, name, description,
    tags, languages, is_nsfw, is_featured,
    verification_status, health_status
)
VALUES (
    '00000000-0000-0000-0000-00000000a900',
    'localhost',
    6668,
    false,
    'Local Anope',
    'Local UnrealIRCd + Anope services for e2e testing.',
    ARRAY['dev', 'local', 'testing', 'anope'],
    ARRAY['en'],
    false,
    true,
    'verified',
    'up'
)
ON CONFLICT (id) DO UPDATE SET
    hostname = EXCLUDED.hostname,
    port = EXCLUDED.port,
    tls = EXCLUDED.tls,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    tags = EXCLUDED.tags,
    languages = EXCLUDED.languages,
    is_nsfw = EXCLUDED.is_nsfw,
    is_featured = EXCLUDED.is_featured,
    verification_status = EXCLUDED.verification_status,
    health_status = EXCLUDED.health_status;
