# did-graphql

Authorize a holder’s wallet to query a GraphQL API directly, using a [ZCAP](https://w3c-ccg.github.io/zcap-spec/) (W3C Authorization Capabilities) delivered over DIDComm, instead of a bearer token, API key, or a hop through CRMS.

## The problem

A DigiCred wallet already holds the things that identify a person in this ecosystem: a DID, DIDComm connections, credentials, and live workflow instances. Workflow screens often need **more than what is already in the wallet** — a college catalog, a CASE framework, program search results — data that lives on a GraphQL API the issuer or marketplace runs.

Three common ways to fetch that data all fail the wallet model:

- **Proxy every query through CRMS.** The coordination server becomes a bottleneck, sees every lookup, and the wallet is never actually authorized against the data source.
- **Ship an API key or OAuth token in the wallet.** A secret in a holder app is hard to attenuate, hard to revoke, and is not how DIDs work. Anyone who copies the token gets the same access.
- **Log the holder into the catalog as a web user.** The relationship already exists as a DIDComm connection. Asking them to create a second account for GraphQL throws that away.

The missing piece is: the issuer already trusts this DID over DIDComm. That trust should be enough to let the wallet call a **specific** GraphQL API, for **specific** queries, for a **limited** time — with no shared secret in the app.

## How the pieces fit

**DIDs** name both sides. The tenant that owns the GraphQL API is the capability `controller`. The holder’s wallet DID is who the capability is delegated *to*. Verification methods on those DIDs are what sign and check invocations. Nothing in this design uses a username, password, or long-lived API key.

**DIDComm** is the channel that already exists between CRMS (sender) and the wallet (receiver). A workflow instance rides that channel. The capability is not fetched from a login page; it is **delegated as a workflow action** (`zcap:delegate`) and stored as an artifact on the instance. The GraphQL call itself is also a workflow action (`graphql:query` / `graphql:mutate`), executed locally by the receiver.

**Wallet artifacts** is where the capability lives after delegation: next to credentials, connections, and the rest of the workflow instance (`artifacts.zcap.graphql`). The wallet is not a dumb viewer of CRMS HTML. It holds an object it can invoke later, offline from CRMS, against the catalog endpoint named in `invocationTarget`.

**GraphQL** is the query language of the resource. Catalogs (colleges, programs, CASE frameworks, …) are naturally a graph. Authorization is not a coarse verb like `read`; this design authorizes by **literal query string**. The delegated capability’s `allowedAction` list is the closed set of GraphQL documents the holder may send. A query that is not on that list is rejected even if the signature is valid.

**ZCAP** (ZCAP-LD, Authorization Capabilities) is the authorization object that ties those together. A capability is delegated, attenuated (the `allowedAction` list, plus `expires`), and later **invoked**: the holder’s agent signs a fresh `capabilityInvocation` proving *this DID is exercising this capability, for this query, right now*. The resource server verifies the chain and the invocation against the tenant’s own DID keys. Caveats are accepted on the wire for shape-compatibility with CRMS’s `Capability` model, but this design does not evaluate them — the query list *is* the attenuation.

CRMS is in the **delegation** path (DIDComm workflow). CRMS is **not** in the **query** path. The wallet talks to GraphQL itself.

## Unknown hosts (contacts send the URL)

The wallet will **not** know the GraphQL host ahead of time. A new college, marketplace, or CASE server shows up as a DIDComm contact; `zcap:delegate` carries `invocationTarget` with the workflow. A vendor allowlist (`*.digicred.services`) is optional policy, not part of the protocol.

That is still safe to **call**, if the wallet treats the contact as the trust root and the HTTP response as **their** data:

- **The ZCAP only opens the URL it names.** A contact cannot mint a capability whose `invocationTarget` is `https://evil/graphql` and have it work against `https://marketplace…/graphql`. Replay at a third-party catalog fails the server’s target check. Sending the header to `evil` only authorizes `evil`.
- **Network guards do not need a pre-known host.** HTTPS, no loopback/RFC1918, pathname `/graphql`, POST only to `invocationTarget`, `redirect: error`. Those stop SSRF and stop the header following to a different origin. They work for any public GraphQL URL a contact sends.
- **Pin when you have a second copy, not a global list.** The workflow template’s `catalog.zcap.graphql.invocationTarget` arrives on the same connection. If it is present, it MUST equal the capability’s target. That catches a swapped artifact. It is not “we already knew this hostname.”
- **Handle the query as untrusted JSON.** A malicious contact can still run a server that returns whatever they want. Do not `eval` it, do not render it as HTML, map it into workflow `context` as data from **this connection**. Timeouts, `GraphQLTransportError`, and `result.errors` are all normal outcomes — fail the action, do not crash the wallet.
- **`allowedHosts` is extra.** Use it to restrict an app build to DigiCred-operated APIs. Leave it unset when any accepted contact may delegate a catalog.

You cannot get a stronger guarantee than “this DIDComm peer’s GraphQL API said so.” That is the same trust as reading a credential they issued. The unsafe thing is calling a URL that is **not** the capability’s GraphQL `invocationTarget`, or treating their JSON as if it came from a host the holder already knew.


## Flow

1. A tenant publishes a GraphQL endpoint. Its controller DID is the root of authority for that resource.
2. A workflow template names that resource under `catalog.zcap.graphql` (`invocationTarget`, `controller`, `allowedAction`).
3. On start (or whenever the template says), the sender runs `zcap:delegate`. The holder’s DID receives an attenuated capability over DIDComm; the wallet stores it as an **instance artifact** (`artifacts.zcap.graphql`).
4. A later `graphql:query` / `graphql:mutate` (executor: receiver) runs in the wallet. **Before any HTTP**, `@digicred-holdings/did-graphql-client` runs the [GraphQL ZCAP validation algorithm](client/README.md#graphql-zcap-validation-algorithm) (`validateGraphqlZcap`): `invocationTarget` MUST be that GraphQL endpoint, HTTPS, not a private IP, `allowedAction` MUST be GraphQL documents, `expires` MUST be valid. This is not proof verification. Then the client asks the holder’s wallet (Bifold / Credo) to sign an invocation and POSTs with `x-zcap-invocation` (`redirect: error`).
5. The resource server (`@digicred-holdings/did-graphql-server`, used by `catalog-graphql`) checks `allowedAction` membership and asks the **tenant’s** agent to verify the chain and invocation. No keys live in these packages.

Neither package does cryptography itself. **Holder signing** is `digicred-wallet` (Bifold + Credo) via the injected `invokeCapability`. **Tenant verification** is the resource tenant’s ACA-Py `w3c_vc` plugin (`POST /w3c-vc/zcaps/root`, `/verify`, and `/invoke/verify`).

## Packages

| Path | What |
|------|------|
| [`client/`](client/) | `@digicred-holdings/did-graphql-client` — wallet/companion client. Invokes a held capability; never signs it (the holder’s agent does). |
| [`server/`](server/) | `@digicred-holdings/did-graphql-server` — resource-server invocation checking. Verifies via the tenant’s agent; holds no keys. |

Technical reference for each package (API, options, optimizations, caching):

- [client/README.md](client/README.md) — including the GraphQL ZCAP validation algorithm (`invocationTarget` MUST be the GraphQL endpoint)
- [server/README.md](server/README.md)

Both have a matching `unsafeMode` (client) / `UNSAFE_MODE` (server) — default off — that skips the agent round-trip for local dev, still using the real header format. Never enable it against real data; both sides log a warning when it is on.

## Operation types: query, mutate, subscribe

`graphql:query` and `graphql:mutate` share one code path. A GraphQL POST does not care whether the document says `query` or `mutation`, and `allowedAction` matches the literal document text either way.

`graphql:subscribe` is a documented placeholder — **not implemented**. Subscriptions need a persistent transport (WebSocket/SSE), not a request/response POST. Build that when a template actually needs it.

## Tests

Integration tests under `test/` spin a Credo agent, create two `did:key` identities (issuer + holder), and sign a delegated ZCAP with **eddsa-jcs-2022**. They start with the unsigned diagnostic `query Auth { zcap { valid } }` (`DidGraphQLClient.checkAuth` / server `checkAuthOnly`) — chain shape and expiry only, no invocation signature.

```bash
npm install
npm test
```

## Examples

[`examples/case-manager`](examples/case-manager) — a sample GraphQL server application for CASE data: `composeModules([caseModule()])` behind a real `http.createServer(...)`, with a built-in GraphiQL explorer. `npx tsx examples/case-manager/server.ts`, no credentials needed by default — set `CONTROLLER_SEED` for a real `eddsa-jcs-2022`-signed capability instead of the unsigned placeholder.
