# ChanServ e2e stacks

Real channel services for the client's ChanServ adapters
(`client/src/renderer/src/modules/chanserv/live.e2e.test.ts`):

| Stack | Host port | Software |
|---|---|---|
| ergo | 16667 | Ergo 2.19.1 (built-in ChanServ) |
| anope | 16668 | UnrealIRCd 6 (nightly image) + Anope 2.0 (stock `chanserv.example.conf`) |
| atheme | 16669 | InspIRCd 3.18 + Atheme 7.2.12 (ChanServ modules + default FLAGS templates) |

Run everything (up, test, down):

```sh
make test-e2e-chanserv                      # all three
make test-e2e-chanserv CHANSERV_STACKS=ergo # one
```

Or keep the stacks up while iterating:

```sh
docker compose -f infra/chanserv-e2e/compose.yaml up -d --wait
cd client && CHANSERV_E2E=ergo,anope,atheme npx vitest run src/renderer/src/modules/chanserv/live.e2e.test.ts
docker compose -f infra/chanserv-e2e/compose.yaml down -v
```

Each stack gets two clients: a founder and a helper register NickServ
accounts and join a fresh channel, then the founder's `ChanServController`
checks the status, registers the channel (the helper's attempt fails: not
opped), grants and lists a role, toggles an option, removes the role,
transfers the channel to the helper (who accepts on Ergo), and the helper
unregisters it (the old founder's attempt is denied).

With `CHANSERV_E2E_WRITE=1` (the make target sets it) each exchange is saved
to `engine/internal/services_e2e/fixtures/<stack>/chanserv-<step>.json`;
`chanserv.fixtures.test.ts` replays them offline in every test run, so a
phrasing change upstream shows up as a failing fixture.

The configs here are copies of `infra/{ergo,anope,atheme}` adjusted for this
suite: no email verification, UnrealIRCd 6 syntax (cloaking, snomasks,
anti-flood), Atheme `auth = none` and the ChanServ modules. On Apple
silicon UnrealIRCd and Atheme run as amd64 images under emulation.
