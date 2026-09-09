# @digicred-holdings/did-graphql-server

Resource-server ZCAP checks for a GraphQL API. It decodes `x-zcap-invocation`, enforces `allowedAction`, and verifies the chain and invocation **entirely in-process** — did:key + `eddsa-jcs-2022` Data Integrity proofs, no external agent call and no database read from inside this package. This package holds no signing keys of its own; the public key it verifies against comes straight from the presented `did:key` string. Signing the invocation is the invoking client's job, never this package's.

See the [repo README](../README.md) for how the pieces fit. This page is the server API, attenuation rules, and the optimizations that are already in place.

## Install

```bash
npm install @digicred-holdings/did-graphql-server
```

Node-only. Depends on `graphql` (query parse / field-subset), `bs58` and `canonicalize` (did:key decoding, JCS canonicalization for `eddsa-jcs-2022`).

## Design: who resolves what

This package does **pure cryptographic and structural verification only**. It is deliberately ignorant of two things a real resource server needs, on purpose:

- **Which root capability is trusted for this request.** A client only ever sends the delegated leaf — the root it descends from is never transmitted (unsigned, trusted by local dereference per the ZCAP-LD spec). Resolving *which* root is trusted for a given request — normally a database lookup keyed by `(controller, id, invocationTarget)` — is the caller's job. This package never queries a database and never reconstructs a root on its own; you hand it the root capability you already trust, and it checks the presented leaf against exactly that object.
- **Which account or tenant a request belongs to.** Not a concept this package has at all. Whatever resolved `rootCapability` you pass in already implies it; there is no separate resolution step here.

Concretely: **the library never calls out to an agent or key service**, and **never opens a database connection**. Both are the consuming resource server's responsibility, using whatever store it keeps its trusted roots in.

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

// Diagnostic: query Auth { auth { zcap { valid } } } — chain only, no invocation.
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

`authModule` and `caseModule()` are `GraphqlModule`s. Each splices exactly one field onto `type Query` — `auth` and `case` — with its own fields on a namespace type behind it, so a host server's own root fields never collide with a module's. `composeModules` concatenates SDL, merges resolvers, and unions `defaultQueries` (GraphiQL / sandbox `allowedAction`).

- **auth** — `query Auth { auth { zcap { valid } } }` (`checkAuthOnly`, no invocation), under `Query.auth`.
- **case** — raw IMS CASE 1.1 (`cfDocuments`, `cfPackage`, `cfItem`, …) under `Query.case`, gated by `checkInvocation`. Any opinionated shape over that vocabulary stays in the consuming server. Full field/query reference: [src/case/README.md](src/case/README.md).

```ts
import { authModule, caseModule, composeModules, mergeResolvers, attachResolvers } from '@digicred-holdings/did-graphql-server'

const composed = composeModules([authModule, caseModule()])
const schema = buildSchema(`${myTypeDefs}\n${composed.sdl}`) // or splice queryFields into your Query
attachResolvers(schema, mergeResolvers(composed.resolvers, { Query: myQueryResolvers }))
```

GraphiQL `defaultQuery` is `authModule.defaultQueries[0]` (`AUTH_QUERY`).

### Type names are global

Query *fields* are namespaced (`Query.auth`, `Query.case`), but GraphQL has no namespacing for **type** names — a schema has exactly one flat type registry, and `buildSchema` rejects a duplicate definition outright. Composing these modules therefore claims these names in your schema:

| From | Types |
|---|---|
| auth | `AuthQueries`, `Zcap` |
| case | `CaseQueries`, `CFDocument`, `CFDocumentResults`, `CFItem`, `CFItemResults`, `CFItemTypeCount`, `CFPackage`, `CFAssociation`, `CFAssociationResults`, `CFAssociationEndpoint`, `CFURIReference`, and the `JSON` scalar |

The `CF*` names come from the CASE 1.1 vocabulary and are unlikely to collide. **`JSON` is the one to watch**: plenty of servers define their own `scalar JSON`, and if yours does, `buildSchema` fails on the duplicate. `Zcap` is generic enough to be worth a glance too.

A collision in SDL fails loudly, at startup, which is the safe direction.

### Resolver collisions throw, they don't merge

The quieter hazard used to be the **resolver** merge. Resolver maps are keyed by type name and field name, and merging them with spreads (`{ ...existing, ...fields }`) means last writer wins: two modules, or a module and your own map, naming the same type *and* field would silently run whichever came last. That matters when the loser is the gated one — the SDL still advertises a gated field while the wired resolver never calls `checkInvocation`, and unlike most wiring mistakes this one fails *open*, with data flowing and nothing logged.

`composeModules` now refuses it, and `mergeResolvers` is exported for merging your own maps against a module's:

```ts
mergeResolvers(composed.resolvers, { Query: myQueryResolvers })
// ResolverCollisionError: map #2 redeclares Query.case, already provided by module 'case' —
// a silently shadowed resolver can drop an authorization check; merge deliberately if you meant to override it
```

Adding your own *distinct* fields to a type a module also resolves is fine — only a same-type-same-field overlap throws. Pass `{ label, resolvers }` instead of a bare map to get your own name in the message. A deliberate override is still possible by spreading by hand; it just has to be deliberate.

This is worth caring about most when a single resolver carries a whole surface's authorization. Hoisting a ZCAP check onto a namespace field (`catalog: async (…) => { await requireAuthorizedQuery(…); return {} }`, with no per-field checks underneath) is a real simplification — one check, impossible to forget on a new field — but it also means shadowing that one resolver ungates every field behind it at once. If you do that, a test that runs an unauthorized document through the composed schema and asserts it is refused is the cheap way to notice.

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
4. A real capabilityInvocation proof, signed by the **leaf's own** controller (the current invoker — a different signer than step 2's delegation proof), matching this capability/target/query, and verifying as `eddsa-jcs-2022`.

`checkAuthOnly` stops after step 2 (unsafe mode: structural + expiry + optional target pin).

### `allowedAction` attenuation

Entries are **real GraphQL documents**, not coarse verbs. Two matches:

1. **Exact** — whitespace-normalized string equality. Cheap; this is the common case when a client sends a registered query verbatim.
2. **Field subset** — the request's root fields, and every nested field under them, are a subset of some registered entry. Trimming, reordering, or dropping fields of an already-allowed query works with no extra catalog entry. `__typename` is ignored (GraphQL metadata). Named fragment spreads are **not** supported and fail closed.

Argument **values** (`limit`, `filter`, …) are **not** constrained. A client allowed to query a field may pass any variables to it. Value-level caveats are a separate, unbuilt axis.

Inline fragments (`... on SomeType`) are walked, as an interface- or union-typed field needs them. Aliased duplicate root fields union their selections.

### What the gate does not cover: schema introspection

`checkInvocation` runs **inside a field resolver**. `__schema` and `__type` are graphql-js built-in meta-fields with no resolver of ours, so a document selecting only those reaches no gated code path and is answered straight from the schema — with no capability present at all. No row of data leaks, but the whole API shape does: every type, field, and argument name, including any administrative surface a host has composed in.

Close it with one call per request, before `graphql()`:

```ts
import { checkIntrospection } from '@digicred-holdings/did-graphql-server'

const introspection = checkIntrospection(zcapConfig, payload, body.query)
if (!introspection.ok) {
  // introspection.code === 'INTROSPECTION_NOT_ALLOWED'
  return sendJson(200, { data: null, errors: [{ message: introspection.message, extensions: { code: introspection.code } }] })
}
```

A document that doesn't introspect always returns `{ ok: true }`, so this is safe to call unconditionally — the per-field gate still does all the real authorization work. Three policies, as the fourth argument:

| Policy | Introspection allowed for |
|---|---|
| `authorized` (default) | Any request presenting a structurally valid, unexpired chain for this `invocationTarget` — what `checkAuthOnly` reports. **Not** `allowedAction` membership: no real capability lists GraphiQL's introspection document, and knowing the shape of an API you already hold a capability for discloses strictly less than the data behind it. In `unsafeMode` this accepts the same structural check everything else does, so a dev GraphiQL page keeps working. |
| `public` | Everyone. The behavior before this existed — correct for an intentionally public schema. |
| `off` | Nobody, capability or not. |

`containsSchemaIntrospection(query)` is exported separately if you want the predicate without the policy. It follows aliases (`{ s: __schema { … } }`), inline fragments, and **named fragment spreads** — introspection hidden a hop away in a fragment is the case a naive string or root-field check misses:

```graphql
query Q { ...F }
fragment F on Query { __schema { types { name } } }
```

`__typename` is not treated as introspection: it discloses only the type of something the caller already selected, the same reason `matchesAllowedAction` ignores it.

## Problem details

Every rejection reason is a `ProblemDetail` (`{ typeURI, title, detail }`), drawn from a fixed vocabulary in `problemDetails.ts`:

`urn:zcap:problemDetail:error:{SLUG}` — `MALFORMED_CAPABILITY`, `UNSUPPORTED_CONTROLLER`, `UNSUPPORTED_CRYPTOSUITE`, `PROOF_INVALID`, `ROOT_CAPABILITY_UNKNOWN` (raised by the *caller's* own lookup, not this package — reserved here for that purpose), `PARENT_CAPABILITY_MISMATCH`, `INVOCATION_TARGET_MISMATCH`, `ATTENUATION_INVALID`, `EXPIRED`, `ACTION_NOT_ALLOWED`, `INVOCATION_MISSING`.

`urn:zcap:problemDetail:warning:{SLUG}` — `LEGACY_ROOT_FIELDS`, `EXPIRES_SOON`. Warnings never cause `verified: false` on their own.

`checkAuthOnly`'s `PresentedZcap.problems` and `checkInvocation`'s `InvocationCheckResult.problems` both carry the raw list; `reason`/`message` are the same information flattened to a string for convenience.

## Optimizations already in place

**No I/O, ever, in the real path.** Every check in `localVerify.ts` is a pure function over the objects you hand it — no network call, no agent, no database.

**Exact match before parse.** `matchesAllowedAction` compares normalized strings first. The GraphQL parser and field-subset walk run only on a miss.

**Subset attenuation.** Register the *widest* query you are willing to allow. Leaner client queries (fewer fields, different order) do not need their own `allowedAction` rows.

**Fail closed on exotic GraphQL.** Unparseable documents, missing operations, or named fragments return "not allowed" rather than a partial allow.

**unsafeMode short-circuit.** Dev/test skips every cryptographic check. Production must leave this off; `configureZcap` warns when it is on.

## Caching

There is nothing to cache here that this package owns — no access token, no agent round-trip, no DB connection. The one thing worth caching is the caller's own **root-capability lookup** (the `(controller, id, invocationTarget)` read) — that's outside this package's scope, and belongs in whatever store the consuming server keeps its roots in.

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
