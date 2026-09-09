# @digicred-holdings/did-graphql-server

## 0.5.0

### Minor Changes

- 5517bee: Add `checkIntrospection` / `containsSchemaIntrospection`, closing an authorization gap: `checkInvocation` runs inside field resolvers, but `__schema`/`__type` are graphql-js built-ins with no resolver, so a document selecting only those reached no gate and was answered from the schema with **no capability present at all**. Data was never exposed, but the full API shape was — every type, field, and argument name.

  `checkIntrospection(config, payload, query, policy?)` is a request-level check a host calls once before `graphql()`. Non-introspecting documents always pass, so it is safe to call unconditionally. Policies: `authorized` (default — any structurally valid, unexpired chain for this target, deliberately not `allowedAction` membership, since no real capability lists GraphiQL's introspection document), `public` (the previous behavior), and `off`.

  `containsSchemaIntrospection` follows aliases, inline fragments, and named fragment spreads, so introspection hidden inside a fragment doesn't slip past. `__typename` is not treated as introspection.

  **This is opt-in for existing consumers**: nothing changes until a host adds the call. A server that wants the old behavior explicitly can pass `'public'`.

- `composeModules` now throws `ResolverCollisionError` when two modules declare a resolver for the same type *and* field, instead of silently letting the last one win, and a new exported `mergeResolvers(...maps)` does the same for a host merging its own resolver map against a module's. A shadowed resolver is a silent, fail-*open* way to lose an authorization check: the SDL still advertises a gated field while the wired resolver never calls `checkInvocation`. Adding distinct fields to a type a module also resolves is unaffected; only a same-type-same-field overlap throws. Pass `{ label, resolvers }` for a named source in the error message.

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
