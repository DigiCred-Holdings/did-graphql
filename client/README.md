# @digicred/did-graphql-client

A GraphQL client that authorizes every request with a [ZCAP](https://w3c-ccg.github.io/zcap-spec/) (W3C Authorization Capabilities) invocation header, instead of a bearer token or API key.

This is the shared client used by any DigiCred wallet-side surface (the `companion-app` web player, and eventually the mobile wallet) to execute the `graphql:query` workflow action locally — the receiver queries a `catalog-graphql` service directly using a capability delegated to it earlier in the workflow (`zcap:delegate` / `catalog.zcap.graphql`), rather than the request going through the CRMS server.

## Usage

```ts
import { DidGraphQLClient } from '@digicred/did-graphql-client'

const client = new DidGraphQLClient({
  endpoint: 'https://marketplace.utopia.sandbox.digicred.services/graphql',
  capability: artifacts.zcap.graphql, // the delegated capability from the workflow instance
})

const result = await client.query({
  query: 'query Dataset($limit: Int, $filter: InstitutionFilter) { colleges(limit: $limit, filter: $filter) { ... } }',
  variables: { limit: 10 },
})
```

### Checking capability validity

```ts
const ok = await client.checkAuth() // query Auth { isZcapValid } — dev/diagnostic only
```

`isExpired(capability)` is also exported for a synchronous, no-network check (e.g. to decide whether to request a refresh before firing a real query).

## Wire conventions

- Capability shape mirrors digicred-crms's real `vaults/v1_0/zcap/model.py::Capability` field-for-field (camelCase: `id`, `controller`, `invocationTarget`, `parentCapability`, `allowedAction`, `expires`, `proof`). `caveat` is accepted for shape-compatibility but never evaluated — this design authorizes via literal query strings in `allowedAction`, not coarse verbs + caveats.
- The capability is sent as a base64-encoded JSON string in an `x-zcap-invocation` request header (see `catalog-graphql-mock`'s server for the reference implementation of the receiving end).
- No cryptographic proof verification happens client-side — this package is for *invoking* a capability, not verifying one. Verification is the resource server's job.

## Build

```bash
npm install
npm run build
```
