# Backend migrations

`golang-migrate` files, embedded into the binary (`migrations/*.sql` in
`../migration.go`) and applied by `server migrate up` / `make migrate-up`.
Add one with `make migrate-create name=add_foo_table`.

## NOTE: directory tables are kept for one release

The server directory moved out of this backend into the standalone service
[boson-chat/directory](https://github.com/boson-chat/directory)
(https://directory.boson.chat). That service imported the listings and also
serves the legacy `api.boson.chat/servers*` routes. The backend no longer
reads or writes these tables:

- `servers` (from `000001`, image columns added in `000008`)
- `user_server_links` (from `000001`)
- `reports` (from `000001`)

They stay for one release as a rollback path. A follow-up migration drops
them once the directory has run a release cycle without a rollback.
`nick_claims.server_id` and `nickserv_secrets.server_id` are free-text IRC
server ids with no foreign key to `servers`, so they are not affected.
