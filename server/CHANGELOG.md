# @digicred-holdings/did-graphql-server

## 0.7.1

### Patch Changes

- bec4126: Vendor the JCS (RFC 8785) canonicalizer instead of depending on `canonicalize`.
  
  `canonicalize@5` is ESM-only: its `exports` map offers an `import` condition and no `require`, so `require('canonicalize')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` even though `main` is still present and pointing at the file. Node ignores `main` entirely once `exports` exists. That makes it unreachable from any CJS consumer — including Jest, which is how a React Native app runs its tests — while Metro resolves it fine via `main`. So the app would work and every consumer's test suite would break, which is a nasty way for a dependency to fail. It also imposes `engines: node >=22` on a mobile app.
  
  None of that buys anything. JCS is RFC 8785 and frozen; `canonicalize` 2.1.0 and 5.0.0 produce byte-identical output across every case tested, including a real delegated ZCAP. The 3.x→5.x majors were packaging changes, not algorithm changes. This is forty lines of settled algorithm that produce the exact bytes we sign, so owning them is better than inheriting another project's packaging decisions.
  
  `canonicalize` stays as a **dev** dependency and the vendored implementation is differentially tested against it on every CI run, so equivalence with the reference is proven rather than assumed. The existing cross-implementation fixture — which pins `hashEddsaJcs2022` byte-for-byte against CrMS's Python signer — still passes unchanged, which is the real evidence that the signed bytes did not move.
  
  `jcs.ts` is duplicated into both packages, because a resource server must not depend on the client. A test asserts the two files are literally identical, so a drift fails in CI (`npm test`) rather than as a verification failure between the two packages. Note it is the test suite that catches this, not `npm run build`.
  
  Also considered and rejected: `json-canonicalize@3`, which is dual-format and current but emits a bare `undefined` for symbol-valued properties, producing output that is not valid JSON. There is now a test asserting our output always parses.

## 0.7.0

### Minor Changes

- 971b8dc: Support RFC 9421 HTTP Message Signatures — the ZCAP spec's own invocation proof.
  
  A request signed this way carries `Content-Digest`, `Signature-Input` and `Signature`, over exactly the components the spec's Example 9 lists: `@method`, `@path`, `capability-invocation`, `content-digest`, `content-type`. That binds the proof to *this* HTTP request rather than to a standalone document.
  
  Clients opt in with a `httpSignature` signer, the same injected shape as `invokeCapability` — this package still holds no keys. Servers pass the request to `checkInvocation`'s new optional fourth argument; a signature cannot be verified without the method, path, headers and body, none of which are reconstructible from the capability header.
  
  The embedded `eddsa-jcs-2022` invocation still works and is still accepted, so existing signers migrate on their own schedule. They are not equivalent: the embedded proof binds the target URL and the query text, while an HTTP signature additionally binds the method, the path, the capability header, and the exact request body. A request carrying `Signature-Input` is verified that way and the embedded path is not consulted, so a weak proof cannot be presented alongside a strong one.
  
  The configured freshness window (`invocationMaxAgeSeconds`) applies to both, reading `created` from `Signature-Input` on the signature path.
  
  The signature base is built independently in each package, since a resource server must not depend on the client. A test asserts the two produce byte-identical output — without it, any drift would surface only as an opaque "signature failed verification".
- fde3102: Reject replayed invocations: `proof.created` is now checked against a freshness window.
  
  An invocation proof binds the `invocationTarget` and the exact query text, so a captured header could never be pointed at another endpoint or reused for a different query. It did not bind **time**. The only deadline was the *capability's* `expires` — months out in real deployments — so anyone who captured one header could replay that one query against that one endpoint for the whole of that period. TLS was the only thing preventing capture.
  
  `proof.created` is inside the signed proof options, so it cannot be adjusted by whoever captured the header. It is now checked against `invocationMaxAgeSeconds` (default 300) with `invocationClockSkewSeconds` (default 60) of tolerance in both directions, since client clocks run fast about as often as slow. Rejections surface as `INVOCATION_STALE` rather than `PROOF_INVALID`, because a replayed header and a forged one call for different responses.
  
  A missing or unparseable `created` fails closed. Every signer in use sets it, so its absence is either a broken client or an attempt to opt out of the window.
  
  **This is a behaviour change.** A client whose clock is off by more than the window will start failing where it previously succeeded. Fix the clock rather than widening the window; `invocationMaxAgeSeconds: 0` restores the old behaviour if you need to unblock first.
  
  This closes the gap in the way that needs no changes outside this library. The ZCAP spec's own answer is HTTP Signatures, whose covered `date` component does the same job — adopting that would mean changing the wallet signer, ACA-Py and companion-app, and is a separate decision.
- 2ba7afa: Send the invocation in a `Capability-Invocation` header, encoded as the ZCAP spec's HTTP binding specifies.
  
  A real deployment reached 9 named queries and its `x-zcap-invocation` header measured **9,724 bytes** — past the limit on both deployed hosts, which cut off between 8KB and 16KB. It failed badly: one proxy returns a bare `400`, surfacing in the wallet as "Graphql transport error: 400" rather than the `431 Request Header Fields Too Large` the other host correctly returns, so the cause reads as a GraphQL fault and is actually header size.
  
  The spec already solves this. Its HTTP binding carries the capability by "serializing it to JSON, gzipping the result, and then base64url-encoding the gzipped JSON" — so compression here is not an optimization bolted on, it is what conformance requires. The same capability now encodes to **1,783 bytes**.
  
  `allowedAction` is untouched: it is inside the delegation signature, and it must stay parseable GraphQL for the exact-match and field-subset gates and for the other implementations that check it. What changed is the transport encoding around the capability, which the verifier gunzips back to byte-identical JSON. Compressing the entries individually would have been both worse and more invasive — the nine queries share heavy token structure, so they are 918 bytes compressed together against 2,294 apart.
  
  Also in this release:
  
  - `InvocationHeaderTooLargeError`, thrown before any HTTP when the built header exceeds `maxHeaderBytes` (default 8192), naming the `allowedAction` count — because the proxy-side failure is so poorly signalled.
  - HTTP 431 now produces an error naming the header and its size.
  - `describeInvocationHeader` distinguishes an absent header from a truncated one. Both previously surfaced as "missing capability", which is precisely what made the original failure look like something else.
  - The inflate is bounded (256KB out, 64KB in) — the server now decompresses attacker-controlled bytes, and an unbounded inflate there would be a memory-exhaustion vector.
  
  Consumer migration is deliberately small and one-time. `decodeInvocationHeader` now takes whatever holds the request headers — Node's `req.headers`, a fetch `Headers`, a plain record — and finds what it needs, so a server never names a header again and a future header change is picked up by upgrading the package. `zcapAllowedHeaders('content-type')` and `ZCAP_REQUEST_HEADERS` do the same for `access-control-allow-headers`, which otherwise fails a browser preflight as a CORS error mentioning nothing about capabilities. `PreparedRequest.headers` is now `Record<string, string>` for the same reason: which headers the client sends is the library's business, not a compile-time contract.
  
  **Upgrade servers before clients.** The server accepts the legacy `x-zcap-invocation` permanently, so an old client against a new server is fine; a client at this version against an older server fails on every request. `encodeInvocationHeader` / `decodeInvocationHeader` stay exported and deprecated.
- 94c253c: Stop ignoring `caveat` and `capabilityChain`. Both are inside the delegation signature, so both are authorization-relevant, and both were previously accepted and never read.
  
  **`caveat` now fails closed.** A caveat is a signed *restriction*, so honouring a capability while ignoring its caveat grants strictly more than the delegator intended — the one direction a verifier must not err in. This library evaluates no caveat types, because it attenuates by literal query document instead, so any caveat at all is unevaluable here and is refused as `CAVEAT_UNSUPPORTED`. `allowUnsupportedCaveats: true` accepts them, for a deployment that knows its caveats are advisory.
  
  **`capabilityChain` is now checked** against the resolved root when present. A capability could previously assert one chain while being verified against another. A chain longer than root → leaf is refused outright rather than verified one link deep and trusted for the rest, surfacing as `CAPABILITY_CHAIN_MISMATCH`.
  
  Neither changes behaviour for capabilities this system already issues: the signer has always emitted a conformant single-entry `capabilityChain`, and nothing issues caveats. There is now a test pinning that, so a regression in the signer surfaces rather than passing silently.
  
  Also documents the three places this library deliberately diverges from the spec — HTTP Signatures for the invocation proof, no `action` header parameter, and no root-zcap invocation — so they read as decisions rather than omissions.
  
  Also fixes the header syntax against the spec's own examples. The value is now emitted **bare** (`capability=<base64url…>`), which is what §Example 9 and 10 show — unpadded base64url contains nothing needing quotes. More importantly the parser previously *required* quotes, so it rejected the spec's own syntax; both forms are now accepted. Safe to change outright because this header shape has not been released yet.

### Patch Changes

- 13fbddf: Bump the two production dependencies that had drifted: `canonicalize` to `^5.0.0` (both packages) and `@noble/hashes` to `^2.4.0` (client).
  
  Both arrived as Dependabot PRs that changed the declared ranges without a changeset, so nothing was released and the published manifests still advertised the old ones. That is not cosmetic for `canonicalize`: the published range `^2.0.0` cannot resolve 5.x, so no consumer would have received the new version until a release went out.
  
  `canonicalize` is load-bearing here — it produces the bytes that get hashed and signed for `eddsa-jcs-2022` — so 2.1.0 and 5.0.0 were compared directly rather than assumed compatible. Output is byte-identical for every well-formed input tested, including a real delegated ZCAP capability and its proof options. The majors are packaging changes (ESM-only from 3.x, a Node engines floor in 5.x), not algorithm changes.
  
  5.x is stricter on malformed input: it rejects lone surrogates, which 2.x serialized. JSON permits lone surrogates, so a client-supplied capability can contain one — but `verifyEddsaJcs2022` already wraps the hash step in `try`/`catch` and returns `false`, so this surfaces as an ordinary `PROOF_INVALID` rejection rather than an error escaping the verifier. Such a document would have failed signature verification under 2.x anyway; it now fails earlier and for a more accurate reason.
- 48e2ad3: Fix a privilege escalation in field-subset matching: a capability granting a query authorized the same-named mutation.
  
  `allowedAction` matching has two paths. The exact path compares document text and was never affected — the operation keyword is part of what it compares. The **field-subset** fallback parsed each document and compared root fields and their nested field names, but never read the operation type. So a capability granting `query Thing { thing { a b } }` also authorized `mutation Thing { thing { a b } }`, wherever a schema exposes the same name on both `Query` and `Mutation`. A read-only grant permitted a write.
  
  Subset matching now requires the operation types to match. Narrowing a granted mutation still works — the fix constrains which entries a document can match, not whether mutations can attenuate. An anonymous `{ ... }` counts as a query, per GraphQL's own default.
  
  No capability needs reissuing. This only ever widened what an existing capability authorized, so the fix can only narrow it back to what was intended.

## 0.6.0

### Minor Changes

- ea1fea3: Accept `graphql` 17 as well as 16 — `"graphql": "^16.14.2 || ^17.0.0"`.
  
  Dependabot proposed moving the declared range to `^17.0.2` outright. That would have been a breaking change for every consumer still on 16, in exchange for nothing: this package's entire `graphql` surface is `parse`, `Kind`, `GraphQLError`, `GraphQLScalarType` and a handful of AST types, all unchanged across the two majors. Widening the range instead lets consumers upgrade on their own schedule, and lets a consumer that already depends on `graphql` dedupe to a single instance rather than ending up with two — which matters more than usual here, since this package hands typeDefs and resolvers to the consumer's own schema.
  
  CI now runs the full suite against both majors rather than only whichever the lockfile happens to pin, because a union range that is only ever exercised on one side is a claim rather than a guarantee.

## 0.5.2

### Patch Changes

- 7a6b2b0: Point the README's install snippets at the public registry — no content change beyond that.

  This release exists to exercise the trusted-publishing path end to end. Both packages' first versions under this scope were published by hand, because npm cannot create a package from OIDC: a trusted publisher can only be attached to a package that already exists. That bootstrap proved the tarballs, not the workflow. Nothing had yet published through `release.yml`'s OIDC identity, so the first real release would have been the first test of it — and the first chance to discover a wrong workflow filename or a missing `id-token: write`. This is that test, with a diff that costs nothing if it fails.

## 0.5.1

### Patch Changes

- 4d79842: `containsSchemaIntrospection` and `checkIntrospection` no longer throw on a non-string `query`.

  0.5.0 added a substring precheck that skipped the parse for documents that cannot introspect — a real saving, since a host following the README calls this on every request. But it sat outside the `try/catch` that had made a bad input safe, so `query.includes('__schema')` threw a TypeError for anything that wasn't a string. A caller's `query` comes from a JSON body, where `{}` yields `undefined`: in an async request handler that TypeError is an unhandled rejection, which ends the **process**, not the request. One malformed body was enough to take a server down.

  Both functions now return `false` / `{ ok: true }` for a non-string, since a non-string is not a document and cannot select anything; their parameters are typed `unknown` to match what a caller actually has. This is defense in depth, not a substitute for validating the body — the README's introspection section now spells out the check a host still owes, and the example server does it.

## 0.5.0

### Minor Changes

- 5517bee: Add `checkIntrospection` / `containsSchemaIntrospection`, closing an authorization gap: `checkInvocation` runs inside field resolvers, but `__schema`/`__type` are graphql-js built-ins with no resolver, so a document selecting only those reached no gate and was answered from the schema with **no capability present at all**. Data was never exposed, but the full API shape was — every type, field, and argument name.

  `checkIntrospection(config, payload, query, policy?)` is a request-level check a host calls once before `graphql()`. Non-introspecting documents always pass, so it is safe to call unconditionally. Policies: `authorized` (default — any structurally valid, unexpired chain for this target, deliberately not `allowedAction` membership, since no real capability lists GraphiQL's introspection document), `public` (the previous behavior), and `off`.

  `containsSchemaIntrospection` follows aliases, inline fragments, and named fragment spreads, so introspection hidden inside a fragment doesn't slip past. `__typename` is not treated as introspection.

  **This is opt-in for existing consumers**: nothing changes until a host adds the call. A server that wants the old behavior explicitly can pass `'public'`.

- `composeModules` now throws `ResolverCollisionError` when two modules declare a resolver for the same type _and_ field, instead of silently letting the last one win, and a new exported `mergeResolvers(...maps)` does the same for a host merging its own resolver map against a module's. A shadowed resolver is a silent, fail-_open_ way to lose an authorization check: the SDL still advertises a gated field while the wired resolver never calls `checkInvocation`. Collisions are: the same field on the same type, the same custom scalar twice, and a type declared as a custom scalar by one map and as field resolvers by another (either order). Adding distinct fields to a type a module also resolves is unaffected. Pass `{ label, resolvers }` for a named source in the error message.

- 9bca076: **Breaking:** the auth module's `zcap` field is now namespaced under `Query.auth` (a new `AuthQueries` type) instead of a flat root field, matching the CASE module's own move to `Query.case`. Each module now splices exactly one field onto the host's `type Query`, so a resource server's own root fields can never collide with a module's.

  `AUTH_QUERY` — exported by both packages, and asserted identical by a test — becomes `query Auth { auth { zcap { valid } } }`. `DidGraphQLClient.checkAuth()` reads `data.auth.zcap.valid` accordingly; its return type is unchanged, so callers of `checkAuth()` need no edit.

  Any hand-written `zcap { … }` diagnostic query needs `auth { … }` wrapped around it. This one is cheaper than the CASE cutover: `Query.auth.zcap` requires no invocation proof and is deliberately not part of any production `allowedAction`, so no already-issued capability has to be re-minted for it.

- **Breaking:** the CASE module's `cfDocuments`/`cfDocument`/`cfPackage`/`cfItem`/`cfItemTypes`/`cfItems`/`cfAssociations` query fields are now namespaced under `Query.case` (a new `CaseQueries` type) instead of flat root fields. `CASE_DEFAULT_QUERIES` is updated to the new nested shape.

  This is a hard cutover, not a deprecate-first migration — the old flat fields no longer exist in the schema at all. Any consumer's own hand-written queries need `case { ... }` wrapped around these fields, and any already-issued ZCAP capability whose `allowedAction` lists the old flat query shape will stop matching (the match is a comparison against the actual query text) and needs re-issuing against the new nested shape.

## 0.4.0

### Minor Changes

- b64b644: Verify did:key + eddsa-jcs-2022 ZCAP-LD capabilities entirely in-process — no ACA-Py agent call, no database access from inside this package. `ZcapServerConfig`'s real (non-`unsafeMode`) shape now takes an explicit `rootCapability` (resolved by the caller's own lookup) instead of an `agentConfig`; `agentClient.ts` and `tenants.ts` (`TenantResolver`) are removed. Only `did:key` root controllers are supported — other DID methods now fail closed with `UNSUPPORTED_CONTROLLER` rather than falling through to an agent call. Rejection reasons are now typed `ProblemDetail`s (`urn:zcap:problemDetail:...`) in addition to the existing string `reason`/`message` fields.

## 0.2.1

### Patch Changes

- 76f2e64: Remove `postinstall: npm run build` from both packages. npm only installs
  `devDependencies` for the top-level project being installed, never for a
  nested/transitive dependency — so when either package is installed as a real
  dependency of a consuming project (e.g. `catalog-graphql`, via
  `file:`/registry install), `postinstall`'s `tsc` build fails outright
  (`@types/pg`/`@types/node`/`typescript` are never present in that context),
  which npm treats as the entire `npm install` failing.

  Both packages already ship a pre-built `dist/` in the published tarball (the
  release workflow runs `npm run build` before `changeset publish`), and both
  declare `"files": ["dist", ...]`, so the postinstall rebuild was always
  redundant for a real consumer — it only ever needs to succeed when developing
  this repo directly (where `npm run build`/`npm run dev` are still available
  as explicit scripts).
