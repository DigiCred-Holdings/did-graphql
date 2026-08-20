# @digicred/did-graphql-client

Wallet-side GraphQL client. It attaches a ZCAP invocation to every request as `x-zcap-invocation` and POSTs JSON to a GraphQL endpoint. It never holds keys and never signs — `invokeCapability` is injected by the caller (`digicred-wallet` / Bifold+Credo, or companion-app talking to that same wallet stack).

This page is the client API, the **GraphQL ZCAP validation algorithm** the wallet runs before it will send a capability anywhere, wire format, and optimizations.

`DidGraphQLClient` calls `validateGraphqlZcap` on construct and on `setCapability`. It will not POST `x-zcap-invocation` until that algorithm succeeds. That check is not signature verification — see [GraphQL ZCAP validation algorithm](#graphql-zcap-validation-algorithm).

## Install

```bash
npm install @digicred/did-graphql-client
```

Until the package is published, consumers use a path dependency (`file:…/client`). Build before importing:

```bash
cd client && npm install && npm run build
```

## Usage

```ts
import { DidGraphQLClient } from '@digicred/did-graphql-client'

const client = new DidGraphQLClient({
  capability: artifacts.zcap.graphql,
  expectedInvocationTarget: template.catalog.zcap.graphql.invocationTarget,
  invokeCapability: async (cap, capabilityAction, invocationTarget) => {
    // digicred-wallet (Bifold + Credo) signs the invocation — not ACA-Py.
    return wallet.invokeZcap({ capability: cap, capabilityAction, invocationTarget })
  },
})

const result = await client.query({
  query: 'query Dataset($limit: Int) { colleges(limit: $limit) { items { name } totalCount } }',
  variables: { limit: 10 },
})
```

Reuse one client for the life of a capability. Call `setCapability()` when the workflow re-delegates; do not construct a new client per query.

## Configuration

| Option | Default | What it does |
|--------|---------|----------------|
| `capability` | required | Delegated leaf ZCAP. Runs `validateGraphqlZcap` on construct / `setCapability`. |
| `expectedInvocationTarget` | none | Independent pin (template `catalog.zcap.graphql.invocationTarget`). MUST equal the capability's GraphQL URL. |
| `allowedHosts` | none | Hostname allowlist (`*.digicred.services`). If set, `invocationTarget` MUST match. |
| `endpoint` | `capability.invocationTarget` | If set, MUST canonicalize to the same URL. This client never POSTs a ZCAP to a different host than the capability names. |
| `invokeCapability` | none | Required for real `query()`. Signs a fresh invocation for this query string. |
| `fetchImpl` | `fetch.bind(globalThis)` | Swap the HTTP stack (tests, React Native). Bound to `globalThis` so browsers do not throw *"'fetch' called on an object that does not implement interface Window."* |
| `checkExpiryBeforeSend` | `true` | Throw `CapabilityExpiredError` locally instead of sending a request the server would reject. |
| `allowInsecureEndpoint` | `false` | Allow `http://` and loopback/private hosts. Local catalog-graphql only. |
| `timeoutMs` | `10000` | Abort the fetch. `0` disables. Combined with the caller's `AbortSignal` if both are present. |
| `unsafeMode` | `false` | Skip signing. Sends the bare chain (same shape as `checkAuth()`). The **server** must also be in unsafe mode. Logs a console warning. Never enable from runtime input. |

```ts
const client = new DidGraphQLClient({
  capability, // invocationTarget MUST already be http://localhost:4100/graphql
  invokeCapability,
  allowInsecureEndpoint: true,
  timeoutMs: 15_000,
})
```

## GraphQL ZCAP validation algorithm

The wallet **MUST** run this before it sends the capability in a header. `DidGraphQLClient` does it automatically on `new DidGraphQLClient(...)` and `setCapability(...)`. You can also call `validateGraphqlZcap` yourself (e.g. to show an error in UI before constructing the client).

This is **not** ZCAP-LD proof verification. The resource server still verifies signatures via the tenant agent. These steps only decide: is this object safe to put on the wire as `x-zcap-invocation`?

`validateGraphqlZcap(capability, options)`:

1. The capability MUST be an object with `id`, `controller`, `invocationTarget`, `allowedAction`, and `proof`.
2. `proof` MUST include `verificationMethod`.
3. `controller` MUST be a DID.
4. `invocationTarget` MUST be an absolute GraphQL HTTP URL: no userinfo, no fragment, pathname `/graphql` (or ending in `/graphql`).
5. The protocol MUST be `https:` unless `allowInsecureEndpoint`.
6. The host MUST NOT be loopback, link-local, or RFC1918 unless `allowInsecureEndpoint`.
7. If `allowedHosts` is set, the host MUST match an entry.
8. If `expectedInvocationTarget` is set, it MUST canonicalize to the same URL as `invocationTarget`.
9. If `endpoint` / `fetchEndpoint` is set, it MUST be that same URL. The client MUST POST only to `invocationTarget`.
10. `allowedAction` MUST be a non-empty list of GraphQL `query` / `mutation` documents (not `subscription`).
11. `expires` MUST be present, parseable, and not in the past.

On success, the client POSTs **only** to the canonical `invocationTarget`. Fetch uses `redirect: 'error'` so the header cannot follow to another origin. Failures throw `InvalidCapabilityError` (or `CapabilityExpiredError` for step 11).

Contacts send `invocationTarget` over DIDComm; the wallet will not have a global host list. That is the intended path. `allowedHosts` is optional app policy. `expectedInvocationTarget` is a same-connection pin (template vs capability), not a pre-provisioned allowlist. Call without `allowedHosts`, keep the algorithm’s HTTPS / private-IP / same-URL rules, and treat `result.data` as untrusted JSON from that peer.

```ts
import { validateGraphqlZcap } from '@digicred/did-graphql-client'

validateGraphqlZcap(artifacts.zcap.graphql, {
  expectedInvocationTarget: template.catalog.zcap.graphql.invocationTarget,
})
```

## API

| Export | Role |
|--------|------|
| `DidGraphQLClient` | `query()`, `checkAuth()`, `setCapability()` |
| `validateGraphqlZcap` / `isValidGraphqlZcap` / `collectGraphqlZcapProblems` | GraphQL ZCAP algorithm (MUST rules above) |
| `prepareInvokedRequest` / `prepareDiagnosticRequest` | Pure header/body builders for a custom HTTP stack — no `fetch` |
| `encodeInvocationHeader` / `decodeInvocationHeader` | `x-zcap-invocation` = base64(JSON) |
| `isExpired` / `validateCapabilityShape` / `isValidCapabilityShape` | Local checks, no network |
| `CapabilityExpiredError`, `InvalidCapabilityError`, `InsecureEndpointError`, `RequestTimeoutError`, `GraphQLTransportError` | Typed failures |

`query(request, { signal })` always signs a **new** invocation whose `capabilityAction` is the query text. That is the string `allowedAction` must match (or contain as a field subset) on the server.

`checkAuth()` POSTs `query Auth { zcap { valid } }` with **no** invocation. Dev/diagnostic only — not a production `allowedAction`. The same `zcap` object can also select `controller`, `invocationTarget`, and `allowedAction`.

## Wire format

`POST {endpoint}`

```
content-type: application/json
x-zcap-invocation: <base64 JSON>
```

Body: `{ query, variables?, operationName? }`.

Header payload:

```ts
{ chain: [leafCapability], invocation?: SignedInvocation }
```

`chain` is leaf-first. The unsigned root is never sent; the server reconstructs it. `invocation` is omitted for `checkAuth()` and for `unsafeMode` queries.

Capability fields match CRMS `vaults/v1_0/zcap/model.py::Capability` (camelCase): `id`, `controller`, `invocationTarget`, `parentCapability`, `allowedAction`, `expires`, `proof`. `caveat` is accepted and ignored.

## Optimizations already in place

These are not knobs. They run unless you opt out of the related option.

**Diagnostic header cache.** Unsigned payloads (`checkAuth()`, `unsafeMode` queries) encode the same capability over and over. `encodeInvocationHeader` caches that base64 string in a `WeakMap` keyed by the capability object. Signed invocations are **not** cached — each one is a new proof.

**GraphQL ZCAP algorithm before I/O.** Constructor and `setCapability()` run `validateGraphqlZcap` (full MUST list above). The client will not send `x-zcap-invocation` until that succeeds.

**Expiry preflight.** With `checkExpiryBeforeSend: true` (default), `query()` also refuses an expired capability rather than hitting the network. Use `isExpired()` if the UI should prompt for re-delegation first.

**Timeout + caller cancel.** One `AbortSignal` wins: the per-request timeout and `opts.signal` are combined. The timeout timer is always cleared.

**Isomorphic base64.** `Buffer` in Node, `btoa`/`atob` with UTF-8 round-trip in the browser / React Native. No polyfill assumed.

**Custom transport.** `prepareInvokedRequest` returns `{ method, headers, body }` if the wallet already has an HTTP layer and only needs the header shape.

**Reuse the client.** `setCapability()` swaps the leaf, re-runs the validation algorithm, and POSTs to the new canonical `invocationTarget`.

## Caching — what this package does and does not do

| Thing | Cached? | Configurable? |
|-------|---------|----------------|
| Unsigned `x-zcap-invocation` header | Yes, `WeakMap` on the capability object | No — always on. Drop the object (or `setCapability` with a new one) and the entry goes away. |
| Signed invocation | **No.** A proof is one-use for one query string, produced fresh by the holder agent. | Do not cache `invokeCapability` results across queries. |
| GraphQL response body | **No.** This is an auth transport, not an Apollo/urql cache. | Cache in the workflow UI (`context_key` on the instance, React Query, etc.). |
| HTTPS / timeout / expiry | Policy, not a cache | The options table above |

Recommended caller-side cache (companion / wallet), not inside this library:

```ts
// One client per workflow instance; cache GraphQL data in instance context.
const client = new DidGraphQLClient({ capability, invokeCapability })

// After a successful query, store result.data on the workflow instance.
// Next screen reads context — no second signed POST for the same browse page.
```

Do **not** cache across holders, capabilities, or `allowedAction` documents. A new delegation (`setCapability`) must start a new data cache.

## Errors

| Error | When |
|-------|------|
| `InvalidCapabilityError` | GraphQL ZCAP algorithm failed (construct / `setCapability` / `validateGraphqlZcap`) |
| `CapabilityExpiredError` | `expires` in the past |
| `RequestTimeoutError` | `timeoutMs` elapsed |
| `GraphQLTransportError` | Non-2xx HTTP |
| `InsecureEndpointError` | Exported for callers; HTTPS failures from the algorithm use `InvalidCapabilityError` |
| `RequestTimeoutError` | `timeoutMs` elapsed |
| `GraphQLTransportError` | Non-2xx HTTP |
| plain `Error` | `query()` without `invokeCapability` and without `unsafeMode` |

GraphQL `{ data, errors }` is a 200 from the server; it is returned, not thrown.

## unsafeMode

Sets the client to send an unsigned chain. Pair it with the server's `unsafeMode`. Useful for companion-app's detached preview and local catalog-graphql without a live agent. It drops the only proof that the holder is the delegatee. Keep it a build-time constant.
