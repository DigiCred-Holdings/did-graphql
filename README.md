# did-graphql

ZCAP-LD (W3C Authorization Capabilities) + GraphQL, for authorizing a receiver-side GraphQL client against a resource server using a delegated capability instead of a bearer token or API key.

## Layout

| Path | What |
|------|------|
| [`client/`](client/) | `@digicred/did-graphql` — the receiver-side client. Invokes capabilities; never signs them itself (see the package's own README for why). |
| [`server/`](server/) | `@digicred/did-graphql-server` — resource-server-side invocation checking. Verifies capabilities; never holds signing/verification keys itself. |

Neither package does any cryptography directly — both defer to a real ACA-Py agent's `w3c_vc` plugin (`plugins/w3c_vc` in `digicred-crms`) for every signature operation: the client calls whatever agent holds its own DID's key to sign an invocation (`POST /w3c-vc/zcaps/invoke`); the server calls the tenant's own agent to verify one (`POST /w3c-vc/zcaps/verify` / `.../invoke/verify`).

Both packages have a matching `unsafeMode` (client) / `UNSAFE_MODE` (server) — default off — that skips the agent round-trip entirely for dev/test, exercising the real wire format without needing a live agent to sign or verify anything. Never enable it against real data; both sides log a loud warning when it's on.

`digicred-crms`'s `services/catalog-graphql` is the concrete resource server built on `@digicred/did-graphql-server`.
