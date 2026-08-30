---
"@digicred-holdings/did-graphql-client": patch
---

Restore a `postinstall` build step, made resilient this time: it no-ops immediately if `dist/` is already present (the published npm tarball ships it prebuilt, so registry installs never hit this), builds with a locally-resolved `typescript` when `dist/` is missing (the case for a git-dependency install, which — unlike a plain npm nested dependency — does get `devDependencies`), and warns without failing the install if neither is true. `did-graphql` is now public, and the wallet's own `git+https` dependency on `did-graphql-client` needs this: without it, any future re-pin to a commit newer than the one that originally removed `postinstall` would ship with no `dist/` at all.
