---
"@digicred-holdings/did-graphql-server": minor
"@digicred-holdings/did-graphql-client": minor
---

**Breaking:** the auth module's `zcap` field is now namespaced under `Query.auth` (a new `AuthQueries` type) instead of a flat root field, matching the CASE module's own move to `Query.case`. Each module now splices exactly one field onto the host's `type Query`, so a resource server's own root fields can never collide with a module's.

`AUTH_QUERY` — exported by both packages, and asserted identical by a test — becomes `query Auth { auth { zcap { valid } } }`. `DidGraphQLClient.checkAuth()` reads `data.auth.zcap.valid` accordingly; its return type is unchanged, so callers of `checkAuth()` need no edit.

Any hand-written `zcap { … }` diagnostic query needs `auth { … }` wrapped around it. This one is cheaper than the CASE cutover: `Query.auth.zcap` requires no invocation proof and is deliberately not part of any production `allowedAction`, so no already-issued capability has to be re-minted for it.
