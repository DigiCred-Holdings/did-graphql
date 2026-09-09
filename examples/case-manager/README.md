# case-manager

A sample GraphQL server application for CASE data — this repo's
reference for what "point `did-graphql-server`'s CASE module at a real
go-case server" looks like end-to-end. One command, a real
`http.createServer(...)`, a built-in GraphiQL explorer, and every one
of the module's own default queries already registered so you can
browse frameworks, item types, and items (with their real
`extensions`) immediately.

## Run it

**You need a go-case server to point at.** This example ships with no
default — bring your own instance (a local go-case run, or any
deployment you have access to) and name it in `CASE_SERVER_URL`. The
server exits immediately with that message if it's unset, rather than
starting up and failing on the first query.

```bash
CASE_SERVER_URL=https://your-go-case-instance npx tsx examples/case-manager/server.ts
```

Then open **http://localhost:4321/graphql** in a browser. The
GraphiQL explorer loads with a real `x-zcap-invocation` header and a
default query already filled in — try `case { cfDocuments }` first to
see what frameworks exist on your server, then
`case { cfItemTypes }`/`case { cfItems }` with a framework title (or
one of the `identifier`s you just saw) from there.

### Or with Docker

Build **from the repo root**, not this directory — the example imports
`client`/`server`/`test` as TS source via relative paths, so the build
context needs all of them:

```bash
docker build -f examples/case-manager/Dockerfile -t case-manager .
docker run --rm -p 4321:4321 -e CASE_SERVER_URL=https://your-go-case-instance case-manager
docker run --rm -p 4321:4321 -e CASE_SERVER_URL=... -e CONTROLLER_SEED=whatever-you-like case-manager
```

Uses `node:22-slim`, not `-alpine` — `@openwallet-foundation/askar-nodejs`
ships a prebuilt native library dynamically linked against glibc
(confirmed with `ldd`); Alpine's musl libc can't load it.

## Config

All optional — every default points at the real go-case sandbox this
repo has been developed against, so the command above needs nothing
else to work.

| Env var | Default | What it does |
|---|---|---|
| `CASE_SERVER_URL` | **required** | Base URL of the go-case server to query. No default — the process exits if it's unset |
| `CASE_SERVER_API_KEY` | unset | Sent as `Authorization: Bearer <key>` — go-case's own read routes need no auth (verified against its source), some deployments front it with one anyway |
| `CASE_PACKAGE_ID` | unset | This deployment's default package — only matters for a query that omits both `packageId` and `framework`. Use `case { cfDocuments }` to find ids on your server |
| `CONTROLLER_SEED` | unset | See below |
| `PORT` | `4321` | |

## `CONTROLLER_SEED` — a real signed capability

By default the demo capability is an **unsigned placeholder**
(`proof: { type: 'none' }`) — the server runs in `unsafeMode`, so it
doesn't check signatures at all, and this keeps the zero-setup path
genuinely zero-setup.

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

### It's really verified, too

The server doesn't just carry a real signature — it checks one. Every
request runs `verifyRequestCapability` (`verifyRequestCapability.ts`)
before touching GraphQL: if the presented capability has a real
`DataIntegrityProof`, its signature is verified for real, using Credo
(backed by Askar) directly — the public key comes straight from
parsing the presented `did:key` string itself (self-certifying, no DID
resolution network call), so this works for *any* did:key-signed
capability, not just one this same process happens to hold. Tamper
with the `proofValue` — flip one character — and the request is
rejected with `CAPABILITY_INVALID`, same as a genuinely invalid
signature would be anywhere else in this repo.

This is a real, additional check layered on top of
did-graphql-server's own `allowedAction`/expiry gate — not a
replacement for it, and that gate still runs `unsafeMode` regardless
(so it still can't check a signature *itself*). Real verification is
`checkInvocation` with `unsafeMode` off — see the package README's
`unsafeMode` section. What's here is: given only the DID on the wire,
can a resource server verify a signature was genuinely produced by
that DID's key, using nothing but Credo/Askar and no network call?
Yes — and this is what that looks like.

When `CONTROLLER_SEED` is unset, the placeholder capability's
`proof: { type: 'none' }` has nothing to verify, so this check is a
no-op — same zero-setup default as before.
