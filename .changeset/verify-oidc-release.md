---
"@digicredholdingsinc/did-graphql-client": patch
"@digicredholdingsinc/did-graphql-server": patch
---

Point the README's install snippets at the public registry — no content change beyond that.

This release exists to exercise the trusted-publishing path end to end. Both packages' first versions under this scope were published by hand, because npm cannot create a package from OIDC: a trusted publisher can only be attached to a package that already exists. That bootstrap proved the tarballs, not the workflow. Nothing had yet published through `release.yml`'s OIDC identity, so the first real release would have been the first test of it — and the first chance to discover a wrong workflow filename or a missing `id-token: write`. This is that test, with a diff that costs nothing if it fails.
