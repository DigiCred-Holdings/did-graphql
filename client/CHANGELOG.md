# @digicred-holdings/did-graphql-client

## 0.3.0

### Minor Changes

- 971b8dc: Support RFC 9421 HTTP Message Signatures — the ZCAP spec's own invocation proof.
  
  A request signed this way carries `Content-Digest`, `Signature-Input` and `Signature`, over exactly the components the spec's Example 9 lists: `@method`, `@path`, `capability-invocation`, `content-digest`, `content-type`. That binds the proof to *this* HTTP request rather than to a standalone document.
  
  Clients opt in with a `httpSignature` signer, the same injected shape as `invokeCapability` — this package still holds no keys. Servers pass the request to `checkInvocation`'s new optional fourth argument; a signature cannot be verified without the method, path, headers and body, none of which are reconstructible from the capability header.
  
  The embedded `eddsa-jcs-2022` invocation still works and is still accepted, so existing signers migrate on their own schedule. They are not equivalent: the embedded proof binds the target URL and the query text, while an HTTP signature additionally binds the method, the path, the capability header, and the exact request body. A request carrying `Signature-Input` is verified that way and the embedded path is not consulted, so a weak proof cannot be presented alongside a strong one.
  
  The configured freshness window (`invocationMaxAgeSeconds`) applies to both, reading `created` from `Signature-Input` on the signature path.
  
  The signature base is built independently in each package, since a resource server must not depend on the client. A test asserts the two produce byte-identical output — without it, any drift would surface only as an opaque "signature failed verification".
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

### Patch Changes

- 13fbddf: Bump the two production dependencies that had drifted: `canonicalize` to `^5.0.0` (both packages) and `@noble/hashes` to `^2.4.0` (client).
  
  Both arrived as Dependabot PRs that changed the declared ranges without a changeset, so nothing was released and the published manifests still advertised the old ones. That is not cosmetic for `canonicalize`: the published range `^2.0.0` cannot resolve 5.x, so no consumer would have received the new version until a release went out.
  
  `canonicalize` is load-bearing here — it produces the bytes that get hashed and signed for `eddsa-jcs-2022` — so 2.1.0 and 5.0.0 were compared directly rather than assumed compatible. Output is byte-identical for every well-formed input tested, including a real delegated ZCAP capability and its proof options. The majors are packaging changes (ESM-only from 3.x, a Node engines floor in 5.x), not algorithm changes.
  
  5.x is stricter on malformed input: it rejects lone surrogates, which 2.x serialized. JSON permits lone surrogates, so a client-supplied capability can contain one — but `verifyEddsaJcs2022` already wraps the hash step in `try`/`catch` and returns `false`, so this surfaces as an ordinary `PROOF_INVALID` rejection rather than an error escaping the verifier. Such a document would have failed signature verification under 2.x anyway; it now fails earlier and for a more accurate reason.

## 0.2.1

### Patch Changes

- 7a6b2b0: Point the README's install snippets at the public registry — no content change beyond that.

  This release exists to exercise the trusted-publishing path end to end. Both packages' first versions under this scope were published by hand, because npm cannot create a package from OIDC: a trusted publisher can only be attached to a package that already exists. That bootstrap proved the tarballs, not the workflow. Nothing had yet published through `release.yml`'s OIDC identity, so the first real release would have been the first test of it — and the first chance to discover a wrong workflow filename or a missing `id-token: write`. This is that test, with a diff that costs nothing if it fails.

## 0.2.0

### Minor Changes

- 9bca076: **Breaking:** the auth module's `zcap` field is now namespaced under `Query.auth` (a new `AuthQueries` type) instead of a flat root field, matching the CASE module's own move to `Query.case`. Each module now splices exactly one field onto the host's `type Query`, so a resource server's own root fields can never collide with a module's.

  `AUTH_QUERY` — exported by both packages, and asserted identical by a test — becomes `query Auth { auth { zcap { valid } } }`. `DidGraphQLClient.checkAuth()` reads `data.auth.zcap.valid` accordingly; its return type is unchanged, so callers of `checkAuth()` need no edit.

  Any hand-written `zcap { … }` diagnostic query needs `auth { … }` wrapped around it. This one is cheaper than the CASE cutover: `Query.auth.zcap` requires no invocation proof and is deliberately not part of any production `allowedAction`, so no already-issued capability has to be re-minted for it.

## 0.1.3

### Patch Changes

- 4dfbb3a: Restore a `postinstall` build step, made resilient this time: it no-ops immediately if `dist/` is already present (the published npm tarball ships it prebuilt, so registry installs never hit this), builds with a locally-resolved `typescript` when `dist/` is missing (the case for a git-dependency install, which — unlike a plain npm nested dependency — does get `devDependencies`), and warns without failing the install if neither is true. `did-graphql` is now public, and the wallet's own `git+https` dependency on `did-graphql-client` needs this: without it, any future re-pin to a commit newer than the one that originally removed `postinstall` would ship with no `dist/` at all.

## 0.1.2

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
