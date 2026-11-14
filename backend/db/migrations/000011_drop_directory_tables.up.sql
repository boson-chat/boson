-- The server directory moved to its own service (boson-chat/directory) and
-- the backend stopped using these tables in 0.48.x. Drop them, dependents
-- first: user_server_links has the only FK into servers; reports has none
-- (target_id is a bare uuid). Their indexes and constraints go with them.
-- nick_claims.server_id / nickserv_secrets.server_id are free-text IRC
-- server ids with no FK to servers and are unaffected.
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS user_server_links;
DROP TABLE IF EXISTS servers;
