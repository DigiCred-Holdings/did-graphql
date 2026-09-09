# @digicred-holdings/did-graphql-client

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
