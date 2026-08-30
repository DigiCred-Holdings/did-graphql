# @digicred-holdings/did-graphql-server

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
