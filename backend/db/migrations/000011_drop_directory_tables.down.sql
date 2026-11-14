-- Recreate the directory tables (empty) exactly as 000001 + 000003 + 000008
-- left them. Data is not restored: take a backup before migrating up.
CREATE TABLE servers (
    id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hostname                      text NOT NULL,
    port                          integer NOT NULL,
    tls                           boolean NOT NULL DEFAULT true,
    name                          text NOT NULL,
    description                   text,
    tags                          text[] NOT NULL DEFAULT '{}',
    languages                     text[] NOT NULL DEFAULT '{}',
    is_nsfw                       boolean NOT NULL DEFAULT false,
    is_featured                   boolean NOT NULL DEFAULT false,
    verification_status           text NOT NULL DEFAULT 'pending',
    verification_token            text,
    verification_last_checked_at  timestamptz,
    health_status                 text NOT NULL DEFAULT 'unknown',
    health_last_checked_at        timestamptz,
    user_count                    integer,
    user_count_updated_at         timestamptz,
    registered_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
    registered_at                 timestamptz NOT NULL DEFAULT now(),
    search_vector                 tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple'::regconfig, coalesce(name, '')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(description, '')), 'B')
    ) STORED,
    -- 000003
    verification_token_issued_at  timestamptz,
    -- 000008
    icon_storage_key              text,
    banner_storage_key            text
);

CREATE INDEX servers_search_vector_idx       ON servers USING GIN (search_vector);
CREATE INDEX servers_tags_idx                ON servers USING GIN (tags);
CREATE INDEX servers_languages_idx           ON servers USING GIN (languages);
CREATE INDEX servers_verification_status_idx ON servers (verification_status);
CREATE INDEX servers_health_status_idx       ON servers (health_status);
CREATE INDEX servers_verification_token_issued_at_idx
    ON servers (verification_token_issued_at)
    WHERE verification_status = 'pending';

CREATE TABLE user_server_links (
    user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id            uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    nick                 text,
    management_mode      text NOT NULL DEFAULT 'derived',
    visibility           text NOT NULL DEFAULT 'private',
    registered_at        timestamptz NOT NULL DEFAULT now(),
    last_sasl_success_at timestamptz,
    status               text NOT NULL DEFAULT 'active',
    PRIMARY KEY (user_id, server_id)
);

CREATE INDEX user_server_links_server_visibility_idx ON user_server_links (server_id, visibility);

CREATE TABLE reports (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    target_type  text NOT NULL,
    target_id    uuid NOT NULL,
    reason       text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    status       text NOT NULL DEFAULT 'open'
);

CREATE INDEX reports_target_idx ON reports (target_type, target_id);
CREATE INDEX reports_status_idx ON reports (status);
