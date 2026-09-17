---
"@digicredholdingsinc/did-graphql-client": patch
"@digicredholdingsinc/did-graphql-server": patch
---

Bump the two production dependencies that had drifted: `canonicalize` to `^5.0.0` (both packages) and `@noble/hashes` to `^2.4.0` (client).

Both arrived as Dependabot PRs that changed the declared ranges without a changeset, so nothing was released and the published manifests still advertised the old ones. That is not cosmetic for `canonicalize`: the published range `^2.0.0` cannot resolve 5.x, so no consumer would have received the new version until a release went out.

`canonicalize` is load-bearing here — it produces the bytes that get hashed and signed for `eddsa-jcs-2022` — so 2.1.0 and 5.0.0 were compared directly rather than assumed compatible. Output is byte-identical for every well-formed input tested, including a real delegated ZCAP capability and its proof options. The majors are packaging changes (ESM-only from 3.x, a Node engines floor in 5.x), not algorithm changes.

5.x is stricter on malformed input: it rejects lone surrogates, which 2.x serialized. JSON permits lone surrogates, so a client-supplied capability can contain one — but `verifyEddsaJcs2022` already wraps the hash step in `try`/`catch` and returns `false`, so this surfaces as an ordinary `PROOF_INVALID` rejection rather than an error escaping the verifier. Such a document would have failed signature verification under 2.x anyway; it now fails earlier and for a more accurate reason.
