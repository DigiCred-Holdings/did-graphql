# @digicred-holdings/did-graphql-server

Resource-server ZCAP checks for a GraphQL API. It decodes `x-zcap-invocation`, enforces `allowedAction`, and verifies the chain and invocation **entirely in-process** — did:key + `eddsa-jcs-2022` Data Integrity proofs, no ACA-Py agent call and no database read from inside this package. This package holds no signing keys of its own; the public key it verifies against comes straight from the presented `did:key` string. Holder signing is `digicred-wallet` (Bifold + Credo), not this package.

See the [repo README](../README.md) for the product story. This page is the server API, attenuation rules, and the optimizations that are already in place.

`digicred-crms`'s `services/catalog-graphql` is the reference consumer.

## Install

```bash
npm install @digicred-holdings/did-graphql-server
```

Node-only. Depends on `graphql` (query parse / field-subset), `bs58` and `canonicalize` (did:key decoding, JCS canonicalization for `eddsa-jcs-2022`).

## Design: who resolves what

This package does **pure cryptographic and structural verification only**. It is deliberately ignorant of two things a real resource server needs, on purpose:

- **Which root capability is trusted for this request.** The wallet only ever sends the delegated leaf — the root it descends from is never transmitted (unsigned, trusted by local dereference per the ZCAP-LD spec). Resolving *which* root is trusted for a given request — normally a database lookup keyed by `(controller, id, invocationTarget)` — is the caller's job. This package never queries a database and never reconstructs a root on its own; you hand it the root capability you already trust, and it checks the presented leaf against exactly that object.
- **Which tenant a request belongs to.** Not a concept this package has at all. Whatever resolved `rootCapability` you pass in already implies the tenant; there is no separate tenant-resolution step here.

Concretely: **the library never calls the tenant's ACA-Py agent**, and **the library never opens a database connection**. Both of those are the consuming resource server's responsibility, using its own store (e.g. digicred-crms's `zcap_capabilities` table).

## Usage

```ts
import {
  configureZcap,
  decodeInvocationHeader,
  checkAuthOnly,
  checkInvocation,
} from '@digicred-holdings/did-graphql-server'

// rootCapability is whatever YOUR lookup resolved for this request —
// e.g. a `zcap_capabilities` row keyed by (controller, id, invocationTarget)
// derived from the Host header. Never reconstructed by this package.
const zcapConfig = configureZcap({
  rootCapability,                          // { id, controller, invocationTarget, ... }
  expectedInvocationTarget: 'https://…/graphql', // derived from this request's Host header
})

const payload = decodeInvocationHeader(req.headers['x-zcap-invocation'])

// Diagnostic: query Auth { zcap { valid } } — chain only, no invocation.
const auth = checkAuthOnly(zcapConfig, payload)

// Real resolver: chain + allowedAction + signed invocation.
const gate = checkInvocation(zcapConfig, payload, rawQueryText)
if (!gate.ok) {
  // gate.code: CAPABILITY_INVALID | QUERY_NOT_ALLOWED | INVOCATION_INVALID
  // gate.problems: ProblemDetail[] — typeURI-tagged, see "Problem details" below
}
```

`checkAuthOnly`/`checkInvocation` are synchronous — no I/O happens inside this package at all.

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

A union of two shapes:

| Field | Required | What it does |
|-------|----------|----------------|
| `rootCapability` | yes (real mode) | The trusted root capability object for this request, resolved by the caller's own lookup. Its `id` is what the leaf's `parentCapability` is checked against; its `controller` (must be a `did:key`) is who the leaf's delegation proof must be signed by. |
| `expectedInvocationTarget` | yes (real mode) | The target this request expects — derived from e.g. the Host header + a fixed path. The leaf's own `invocationTarget` must equal this. |
| `unsafeMode` | default `false` | Skip all cryptographic verification. Structural shape + expiry + `allowedAction` only, checked against `trust.trustedRootController`/`trust.expectedInvocationTarget` (a fixed pair, not a per-request lookup). Dev/test only. |

Only `did:key` root controllers are supported — any other DID method fails closed with an `UNSUPPORTED_CONTROLLER` problem. There is no agent fallback for other methods.

## What the gate actually checks

`checkInvocation`, in order:

1. Leaf present.
2. Chain valid (`verifyChain` in `localVerify.ts`):
   - both root and leaf controllers are `did:key`,
   - leaf `invocationTarget` matches `expectedInvocationTarget` (the Host-header cross-check),
   - leaf `parentCapability` matches the resolved root's `id` (a separate, explicit check — not folded into any lookup),
   - leaf not expired,
   - leaf's delegation proof (`proofPurpose: capabilityDelegation`) is signed by the **root's** controller, and verifies as `eddsa-jcs-2022`.
3. `allowedAction` membership (see below).
4. A real capabilityInvocation proof, signed by the **leaf's own** controller (the current holder — a different signer than step 2's delegation proof), matching this capability/target/query, and verifying as `eddsa-jcs-2022`.

`checkAuthOnly` stops after step 2 (unsafe mode: structural + expiry + optional target pin).

### `allowedAction` attenuation

Entries are **real GraphQL documents**, not coarse verbs. Two matches:

1. **Exact** — whitespace-normalized string equality. Cheap; this is the common case when the wallet sends a registered query verbatim.
2. **Field subset** — the request's root fields, and every nested field under them, are a subset of some registered entry. Trimming, reordering, or dropping fields of an already-allowed query works with no extra catalog entry. `__typename` is ignored (GraphQL metadata). Named fragment spreads are **not** supported and fail closed.

Argument **values** (`limit`, `filter`, …) are **not** constrained. A holder who may query `colleges` may pass any variables. Value-level caveats are a separate, unbuilt axis.

Inline fragments (`... on College`) are walked (needed for `node`). Aliased duplicate root fields union their selections.

## Problem details

Every rejection reason is a `ProblemDetail` (`{ typeURI, title, detail }`), drawn from a fixed vocabulary in `problemDetails.ts`:

`urn:zcap:problemDetail:error:{SLUG}` — `MALFORMED_CAPABILITY`, `UNSUPPORTED_CONTROLLER`, `UNSUPPORTED_CRYPTOSUITE`, `PROOF_INVALID`, `ROOT_CAPABILITY_UNKNOWN` (raised by the *caller's* own lookup, not this package — reserved here for that purpose), `PARENT_CAPABILITY_MISMATCH`, `INVOCATION_TARGET_MISMATCH`, `ATTENUATION_INVALID`, `EXPIRED`, `ACTION_NOT_ALLOWED`, `INVOCATION_MISSING`.

`urn:zcap:problemDetail:warning:{SLUG}` — `LEGACY_ROOT_FIELDS`, `EXPIRES_SOON`. Warnings never cause `verified: false` on their own.

`checkAuthOnly`'s `PresentedZcap.problems` and `checkInvocation`'s `InvocationCheckResult.problems` both carry the raw list; `reason`/`message` are the same information flattened to a string for convenience.

## Optimizations already in place

**No I/O, ever, in the real path.** Every check in `localVerify.ts` is a pure function over the objects you hand it — no network call, no agent, no database.

**Exact match before parse.** `matchesAllowedAction` compares normalized strings first. The GraphQL parser and field-subset walk run only on a miss.

**Subset attenuation.** Register the *widest* query you are willing to allow. Leaner wallet queries (fewer fields, different order) do not need their own `allowedAction` rows.

**Fail closed on exotic GraphQL.** Unparseable documents, missing operations, or named fragments return "not allowed" rather than a partial allow.

**unsafeMode short-circuit.** Dev/test skips every cryptographic check. Production must leave this off; `configureZcap` warns when it is on.

## Caching

There is nothing to cache here that this package owns — no Traction token, no agent round-trip, no DB connection. The one thing worth caching is the caller's own **root-capability lookup** (the `(controller, id, invocationTarget)` DB read) — that's outside this package's scope; see catalog-graphql's own docs for its caching story.

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
| `INVOCATION_INVALID` | Missing invocation, wrong signer, or the invocation proof failed verification |

`decodeInvocationHeader` returns `null` on missing/invalid base64 JSON rather than throwing.
