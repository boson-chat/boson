# Backend migrations

`golang-migrate` files, embedded into the binary (`migrations/*.sql` in
`../migration.go`) and applied by `server migrate up` / `make migrate-up`.
Add one with `make migrate-create name=add_foo_table`.

## Directory tables (dropped in `000011`)

The server directory moved out of this backend into the standalone service
[boson-chat/directory](https://github.com/boson-chat/directory)
(https://directory.boson.chat), which imported the listings and also serves
the legacy `api.boson.chat/servers*` routes. `000011_drop_directory_tables`
drops `servers`, `user_server_links` and `reports`; its down migration
recreates them empty (data is not restored, so back them up before
migrating up). `nick_claims.server_id` and `nickserv_secrets.server_id` are
free-text IRC server ids with no foreign key to `servers`.

`migrations_test.go` round-trips every migration (up, down, up) against
Postgres.
