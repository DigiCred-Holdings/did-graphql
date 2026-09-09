# did-graphql

Authorize GraphQL requests with a [ZCAP](https://w3c-ccg.github.io/zcap-spec/) (W3C Authorization Capabilities) signed by a DID key, instead of a bearer token, an API key, or a proxy hop through a coordination server.

Two packages: a client that invokes a capability it holds, and a resource server that verifies the invocation. Neither holds a signing key.

## The problem

A client app holds a DID and, often, an existing trust relationship with whoever runs the data — an issuer, a peer, a service it was introduced to. Then it needs data that isn't local: a catalog, a reference dataset, a search index living behind someone else's GraphQL API.

Three common ways to reach that data all fight the DID model:

- **Proxy every query through a coordination server.** That server becomes a bottleneck, sees every lookup, and the client is never actually authorized against the data source.
- **Ship an API key or OAuth token in the client.** A secret in a client app is hard to attenuate, hard to revoke, and shared by every install. Anyone who copies it gets the same access.
- **Make the user log into the API as a web account.** A DID-based relationship already exists; asking for a second, password-based identity throws that away.

The missing piece: whoever runs the API already trusts this DID. That trust should be enough to let the client call a **specific** GraphQL endpoint, for **specific** queries, for a **limited** time, with no shared secret in the app.

## How the pieces fit

**DIDs** name both sides. Whoever owns the GraphQL endpoint is the capability `controller`; the client's DID is who the capability is delegated *to*. Verification methods on those DIDs sign and check invocations. Nothing here uses a username, a password, or a long-lived API key.

**Delegation happens out of band**, and this library doesn't care how. DIDComm, an authenticated REST call, a QR code, a file drop — all that matters is that the client ends up holding a capability object naming an `invocationTarget` it can invoke later, independently of whoever delegated it.

**GraphQL** is the resource's own query language. Authorization is not a coarse verb like `read`: this design authorizes by **literal query document**. A capability's `allowedAction` list is the closed set of GraphQL documents the client holding it may send, and a document that isn't on the list is rejected even when the signature is perfectly valid.

**ZCAP** ties those together. A capability is delegated, attenuated (the `allowedAction` list, plus `expires`), and later **invoked**: the client signs a fresh `capabilityInvocation` proving *this DID is exercising this capability, for this document, right now*. The resource server verifies the chain and the invocation against the controller's DID keys. `caveat` is accepted on the wire for shape compatibility with other ZCAP implementations, but nothing here evaluates it — the query list *is* the attenuation.

The delegating party is in the **delegation** path only. It is **not** in the **query** path: the client talks to the GraphQL endpoint directly.

## Unknown hosts (the delegator sends the URL)

A client generally won't know the GraphQL host ahead of time. A new peer shows up, and the capability it delegates carries the `invocationTarget` with it. A host allowlist (`*.example.org`) is optional deployment policy, not part of the protocol.

That is still safe to **call**, as long as the client treats the delegating peer as the trust root and the HTTP response as **their** data:

- **The ZCAP only opens the URL it names.** A peer cannot mint a capability whose `invocationTarget` is `https://evil.example/graphql` and have it work against someone else's endpoint. Replay elsewhere fails that server's target check; sending the header to `evil.example` only ever authorizes `evil.example`.
- **Network guards need no pre-known host.** HTTPS, no loopback or RFC1918 address, pathname `/graphql`, POST only to `invocationTarget`, `redirect: error`. Those stop SSRF and stop the header following a redirect to a different origin — for any public GraphQL URL a peer sends.
- **Pin when you have a second copy, not a global list.** If the delegating channel separately states the expected `invocationTarget`, it MUST equal the capability's own. That catches a swapped capability. It is not "we already knew this hostname".
- **Treat the response as untrusted JSON.** A malicious peer can still run a server that returns anything. Don't `eval` it, don't render it as HTML, and treat what you map into your own state as data from *that peer*. Timeouts, transport errors, and `result.errors` are all normal outcomes — fail the operation, don't crash the app.
- **`allowedHosts` is extra.** Use it to restrict a build to a known set of APIs. Leave it unset when any accepted peer may delegate an endpoint.

You cannot get a stronger guarantee than "this peer's GraphQL API said so" — the same trust as reading a credential they issued. The unsafe thing is calling a URL that is **not** the capability's `invocationTarget`, or treating their JSON as if it came from a host you already knew.

## Flow

1. Someone publishes a GraphQL endpoint. Its controller DID is the root of authority for that resource.
2. That party delegates an attenuated capability to a client's DID — naming the `invocationTarget`, the `controller`, and the `allowedAction` documents — over whatever channel they already share.
3. The client stores the capability. It can now invoke it without the delegator's involvement.
4. Before any HTTP, `@digicred-holdings/did-graphql-client` runs the [GraphQL ZCAP validation algorithm](client/README.md#graphql-zcap-validation-algorithm) (`validateGraphqlZcap`): `invocationTarget` MUST be a GraphQL endpoint, HTTPS, not a private IP; `allowedAction` MUST be GraphQL documents; `expires` MUST be valid. This is structural validation, not proof verification. Then it asks the caller-supplied signer for an invocation and POSTs with `x-zcap-invocation` (`redirect: error`).
5. The resource server (`@digicred-holdings/did-graphql-server`) checks `allowedAction` membership and verifies the chain and invocation — `did:key` + `eddsa-jcs-2022`, entirely in-process. No signing keys live in either package.

Signing is always the caller's: the client package never holds a key, and gets invocations from an injected `invokeCapability` function backed by whatever key store the app already uses.

## Packages

| Path | What |
|------|------|
| [`client/`](client/) | `@digicred-holdings/did-graphql-client` — invokes a held capability and POSTs the request. Never signs it itself. |
| [`server/`](server/) | `@digicred-holdings/did-graphql-server` — resource-server invocation checking, plus optional GraphQL modules. Verifies in-process; holds no keys. |

Technical reference for each package (API, options, optimizations, caching):

- [client/README.md](client/README.md) — including the GraphQL ZCAP validation algorithm (`invocationTarget` MUST be the GraphQL endpoint)
- [server/README.md](server/README.md)

Both have a matching `unsafeMode` (client) / `UNSAFE_MODE` (server) — default off — that keeps the real header format but skips signature verification, for local dev. Never enable it against real data; both sides log a warning when it is on.

## Operation types: query, mutate, subscribe

Queries and mutations share one code path. A GraphQL POST doesn't care whether the document says `query` or `mutation`, and `allowedAction` matches the literal document text either way.

Subscriptions are **not implemented**. They need a persistent transport (WebSocket/SSE) rather than a request/response POST — build that when something actually needs it.

## Tests

Integration tests under `test/` spin up a Credo agent, create two `did:key` identities (delegator + invoker), and sign a delegated ZCAP with **eddsa-jcs-2022**. They start with the unsigned diagnostic `query Auth { auth { zcap { valid } } }` (`DidGraphQLClient.checkAuth` / server `checkAuthOnly`) — chain shape and expiry only, no invocation signature.

```bash
npm install
npm test
```

## Examples

[`examples/case-manager`](examples/case-manager) — a sample GraphQL server for CASE framework data: `composeModules([caseModule()])` behind a real `http.createServer(...)`, with a built-in GraphiQL explorer. `npx tsx examples/case-manager/server.ts`, no credentials needed by default — set `CONTROLLER_SEED` for a real `eddsa-jcs-2022`-signed capability instead of the unsigned placeholder.
