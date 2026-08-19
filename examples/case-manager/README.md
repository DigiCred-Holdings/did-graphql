# case-manager

A sample GraphQL server application for CASE data — this repo's
reference for what "point `did-graphql-server`'s CASE module at a real
go-case server" looks like end-to-end. One command, a real
`http.createServer(...)`, a built-in GraphiQL explorer, and every one
of the module's own default queries already registered so you can
browse frameworks, item types, and items (with their real
`extensions`) immediately.

## Run it

```bash
npx tsx examples/case-manager/server.ts
```

Then open **http://localhost:4321/graphql** in a browser. The
GraphiQL explorer loads with a real `x-zcap-invocation` header and a
default query already filled in — try `cfDocuments` first to see what
frameworks exist on the server, then `cfItemTypes`/`cfItems` with a
framework title you find there.

## Config

All optional — every default points at the real go-case sandbox this
repo has been developed against, so the command above needs nothing
else to work.

| Env var | Default | What it does |
|---|---|---|
| `CASE_SERVER_URL` | the go-case sandbox | Which go-case server to query |
| `CASE_SERVER_API_KEY` | unset | Sent as `Authorization: Bearer <key>` — go-case's own read routes need no auth (verified against its source), some deployments front it with one anyway |
| `CASE_PACKAGE_ID` | Wyoming Higher Education | This deployment's default package — only matters for a query that omits both `packageId` and `framework` |
| `CONTROLLER_SEED` | unset | See below |
| `PORT` | `4321` | |

## `CONTROLLER_SEED` — a real signed capability

By default the demo capability is an **unsigned placeholder**
(`proof: { type: 'none' }`) — the server runs in `unsafeMode`, so
there's no live ACA-Py agent for it to check a real signature against
anyway, and this keeps the zero-setup path genuinely zero-setup.

Set `CONTROLLER_SEED` to something (any string) and the capability is
signed for real instead:

```bash
CONTROLLER_SEED=whatever-you-like npx tsx examples/case-manager/server.ts
```

What actually happens: the same seed is hashed (sha256) down to 32
bytes and handed to **Askar**'s `Key.fromSeed` to deterministically
derive a real Ed25519 key — the same seed always produces the same
`did:key`, with nothing persisted to disk. That key signs the
capability with a real **Data Integrity proof, `eddsa-jcs-2022`**
(the same cryptosuite this repo's real tests use — see
`test/helpers/eddsaJcs2022.ts`, reused here directly rather than
reimplemented). The startup log prints the derived `did:key` so you
can see it's real and reproducible — run it twice with the same seed
and you'll get the identical DID both times.

What this does **not** change: the server still runs `unsafeMode` —
`allowedAction` gating still works exactly the same either way, but
there's still no live agent here to actually verify that signature
against. `CONTROLLER_SEED` changes what the *wire* carries (a real
signed capability vs. the placeholder), not what the server checks.
See the package README's `unsafeMode` section for what a real,
agent-verified deployment (like `catalog-graphql`) does instead.
