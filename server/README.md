# @digicred-holdings/did-graphql-server

Resource-server ZCAP checks for a GraphQL API. It decodes `x-zcap-invocation`, enforces `allowedAction`, and verifies the chain and invocation. **`did:key` is verified locally** (the public key is in the DID). Other DID methods fall through to the tenant's ACA-Py agent. This package holds no signing keys. Holder signing is `digicred-wallet` (Bifold + Credo), not this package.

See the [repo README](../README.md) for the product story. This page is the server API, attenuation rules, and the optimizations that are already in place.

`digicred-crms`'s `services/catalog-graphql` is the reference consumer.

## Install

```bash
npm install @digicred-holdings/did-graphql-server
```

Until published, catalog-graphql vendors this package (`file:./vendor/did-graphql-server`) or depends on `file:…/server`. A git dependency pinned to this repo's `server` workspace also works, the same way — see the client README's [Install](../client/README.md#install) for the `workspace=` syntax and why `files` lists `src`/`tsconfig.json` alongside `dist`.

For a local `file:` dependency, build first:

```bash
cd server && npm install && npm run build
```

Node-only. Depends on `graphql` (query parse / field-subset), `canonicalize` + `bs58` (local `did:key` / eddsa-jcs-2022 verify), and `pg` (optional `TenantResolver`).

## Usage

```ts
import {
  configureZcap,
  decodeInvocationHeader,
  checkAuthOnly,
  checkInvocation,
} from '@digicred-holdings/did-graphql-server'

const zcapConfig = configureZcap({
  trust: {
    trustedRootController: tenant.publicDid,       // capability controller DID
    expectedInvocationTarget: 'https://…/graphql', // optional pin
  },
  // agentConfig is only required when a DID on the chain is not did:key.
})

const payload = decodeInvocationHeader(req.headers['x-zcap-invocation'])

// Diagnostic: query Auth { zcap { valid } } — chain only, no invocation.
const auth = await checkAuthOnly(zcapConfig, payload)

// Real resolver: chain + allowedAction + signed invocation.
const gate = await checkInvocation(zcapConfig, payload, rawQueryText)
if (!gate.ok) {
  // gate.code: CAPABILITY_INVALID | QUERY_NOT_ALLOWED | INVOCATION_INVALID
}
```

`configureZcap()` is required at startup (or whenever you build a config). It logs a warning if `unsafeMode` is on. `agentConfig` is optional: omit it when issuer and holder are `did:key`.

## GraphQL modules

`authModule` and `caseModule()` are `GraphqlModule`s. `composeModules` concatenates SDL, merges Query resolvers, and unions `defaultQueries` (GraphiQL / sandbox `allowedAction`).

- **auth** — `query Auth { zcap { valid } }` (`checkAuthOnly`, no invocation).
- **case** — raw IMS CASE 1.1 (`cfDocuments`, `cfPackage`, `cfItem`, …) gated by `checkInvocation`. College/Program mapping stays in catalog-graphql. Full field/query reference: [src/case/README.md](src/case/README.md).

```ts
import { authModule, caseModule, composeModules, attachResolvers } from '@digicred-holdings/did-graphql-server'

const composed = composeModules([authModule, caseModule()])
const schema = buildSchema(`${catalogTypeDefs}\n${composed.sdl}`) // or splice queryFields into your Query
attachResolvers(schema, { ...composed.resolvers, Query: { ...composed.resolvers.Query, ...catalogQuery } })
```

GraphiQL `defaultQuery` is `authModule.defaultQueries[0]` (`AUTH_QUERY`).

## Configuration

### `ZcapServerConfig`

| Field | Required | What it does |
|-------|----------|----------------|
| `trust.trustedRootController` | yes | Tenant public DID. Root of the delegation chain. |
| `trust.expectedInvocationTarget` | no | If set, the leaf `invocationTarget` must equal this URL. |
| `agentConfig.baseUrl` | only if not did:key | Traction / ACA-Py base URL. Unused on the local did:key path. |
| `agentConfig.token` | only if not did:key | Bearer token for the tenant wallet. |
| `agentConfig.apiKey` | no | Extra `x-api-key` header some agents expect. |
| `unsafeMode` | default `false` | Skip all signature checks. Structural shape + expiry + `allowedAction` only. |

### Multi-tenant: `TenantResolver`

One deployment, many CRMS tenants. Looks up `tenants` in the **same Postgres** crms-ui uses. For a `did:key` `public_did` it returns trust config only — no Traction token. For other DID methods it decrypts `traction_tenant_api_key` (AES-256-GCM `enc:v1:…`, `ENCRYPTION_KEY`), fetches a Traction token, and returns `agentConfig` so verification can fall through to the tenant agent.

```ts
import { TenantResolver } from '@digicred-holdings/did-graphql-server'

const tenants = new TenantResolver({
  connectionString: process.env.DATABASE_URL!,
  encryptionKey: process.env.ENCRYPTION_KEY!,
})

const zcapConfig = await tenants.resolveZcapConfig(req.headers.host, {
  expectedInvocationTarget: process.env.EXPECTED_INVOCATION_TARGET,
})
```

Hostname lookup order matches `TenantsService.findByHostname`: exact host → host without port → `localhost` / `127.0.0.1` swap.

Call `tenants.close()` on shutdown to drain the `pg` pool.

`TenantResolver` is intentionally bound to digicred-crms's `tenants` columns. A schema-agnostic resolver is not provided.

## What the gate actually checks

`checkInvocation` in order:

1. Leaf present.
2. Chain valid — the unsigned root is **materialized locally** (`urn:zcap:root:` + controller + target). The wallet never sends the root. `did:key` proofs are checked with eddsa-jcs-2022 in this process. Other DID methods `POST /w3c-vc/zcaps/verify`.
3. `allowedAction` membership (see below).
4. Signed invocation — local eddsa-jcs-2022 for `did:key`, otherwise `POST /w3c-vc/zcaps/invoke/verify`.

`checkAuthOnly` stops after step 2 (unsafe mode: structural + expiry + optional target pin).

### `allowedAction` attenuation

Entries are **real GraphQL documents**, not coarse verbs. Two matches:

1. **Exact** — whitespace-normalized string equality. Cheap; this is the common case when the wallet sends a registered query verbatim.
2. **Field subset** — the request's root fields, and every nested field under them, are a subset of some registered entry. Trimming, reordering, or dropping fields of an already-allowed query works with no extra catalog entry. `__typename` is ignored (GraphQL metadata). Named fragment spreads are **not** supported and fail closed.

Argument **values** (`limit`, `filter`, …) are **not** constrained. A holder who may query `colleges` may pass any variables. Value-level caveats are a separate, unbuilt axis.

Inline fragments (`... on College`) are walked (needed for `node`). Aliased duplicate root fields union their selections.

## Agent calls

Used only when a DID on the chain is **not** `did:key`. The unsigned root is always built in-process (`materializeRoot`); `POST /w3c-vc/zcaps/root` is not on the query path.

| When | Route |
|------|--------|
| Diagnostic / chain (non-did:key) | `POST /w3c-vc/zcaps/verify` |
| Real query (non-did:key) | `POST /w3c-vc/zcaps/invoke/verify` |

All go through `agentClient.ts`. Crypto for those methods is Data Integrity `eddsa-jcs-2022` inside the agent's `w3c_vc` plugin.

## Optimizations already in place

**Local did:key verify.** Default. No Traction token, no agent HTTP, no root mint round-trip. Node `crypto` verifies Ed25519; JCS via `canonicalize`.

**Exact match before parse.** `matchesAllowedAction` compares normalized strings first. The GraphQL parser and field-subset walk run only on a miss.

**Subset attenuation.** Register the *widest* query you are willing to allow. Leaner wallet queries (fewer fields, different order) do not need their own `allowedAction` rows.

**`pg` connection pool.** `TenantResolver` uses `pg.Pool`, so tenant lookups reuse TCP connections to Postgres. That is connection pooling, not a result cache.

**Fail closed on exotic GraphQL.** Unparseable documents, missing operations, or named fragments return "not allowed" rather than a partial allow.

**unsafeMode short-circuit.** Dev/test skips every signature check after the structural check. Production must leave this off; `configureZcap` warns when it is on.

## Caching — what this package does and does not do

`did:key` verification does not talk to Traction. Token fetch and agent verify still have **no built-in TTL cache** when a non-did:key DID forces the agent path.

| Thing | Cached in this package? | What a service can do |
|-------|-------------------------|------------------------|
| Postgres connections | Yes — `pg.Pool` | Tune via the connection string (`max`, `idle_timeout`, …). The constructor only takes `connectionString`; extra `Pool` options are not a first-class API yet. |
| Tenant row lookup | No | Short TTL keyed by hostname around `findRowByHostname` / `resolveZcapConfig`. |
| Traction Bearer token | **Not fetched** for `did:key` `public_did`. For other methods: **No** (fresh `POST …/token` every `resolveZcapConfig`) | Wrap `resolveZcapConfig` with a per-hostname cache if you still hit the agent path. |
| Minted root capability | Built locally every time (cheap JSON) | Not an HTTP cache. |
| `verify` / `invoke/verify` | **No.** Invocations are per request. Not called for did:key. | Do not cache "this invocation was valid". |
| GraphQL result / gzip | Not this package | catalog-graphql gzips JSON when `Accept-Encoding: gzip`. Response caching belongs in the wallet or a CDN in front of public catalog data, not in the ZCAP gate. |

Example wrapper a resource server can add **outside** this library:

```ts
type Entry = { config: ZcapServerConfig; expiresAt: number }
const tokenCache = new Map<string, Entry>()
const TOKEN_TTL_MS = 45_000

async function zcapConfigFor(hostname: string): Promise<ZcapServerConfig> {
  const hit = tokenCache.get(hostname)
  if (hit && hit.expiresAt > Date.now()) return hit.config

  const config = await tenants.resolveZcapConfig(hostname, {
    expectedInvocationTarget: process.env.EXPECTED_INVOCATION_TARGET,
  })
  if (!config) throw new Error(`no tenant for ${hostname}`)
  tokenCache.set(hostname, { config, expiresAt: Date.now() + TOKEN_TTL_MS })
  return config
}
```

Evict on agent `401` so a rotated wallet key does not stick. Do not share this cache across processes without considering Traction token scope (it is a tenant wallet token, not a user session).

## unsafeMode

```ts
configureZcap({
  unsafeMode: true,
  trust: { trustedRootController: 'did:unsafe:placeholder' },
})
```

Accepts a structurally valid, unexpired leaf with a matching `allowedAction`, **no** signature. Pair with the client's `unsafeMode`. Never point this at real catalog data.

## Errors from `checkInvocation`

| `code` | Meaning |
|--------|---------|
| `CAPABILITY_INVALID` | Missing leaf, bad shape, expired, chain verify failed, target mismatch |
| `QUERY_NOT_ALLOWED` | Document is not an exact/`subset` match of `allowedAction` |
| `INVOCATION_INVALID` | Missing invocation, or `invoke/verify` failed |

`decodeInvocationHeader` returns `null` on missing/invalid base64 JSON rather than throwing.
