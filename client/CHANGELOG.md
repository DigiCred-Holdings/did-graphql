# @digicred-holdings/did-graphql-client

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
