---
"@digicredholdingsinc/did-graphql-client": patch
"@digicredholdingsinc/did-graphql-server": patch
---

Vendor the JCS (RFC 8785) canonicalizer instead of depending on `canonicalize`.

`canonicalize@5` is ESM-only: its `exports` map offers an `import` condition and no `require`, so `require('canonicalize')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` even though `main` is still present and pointing at the file. Node ignores `main` entirely once `exports` exists. That makes it unreachable from any CJS consumer — including Jest, which is how a React Native app runs its tests — while Metro resolves it fine via `main`. So the app would work and every consumer's test suite would break, which is a nasty way for a dependency to fail. It also imposes `engines: node >=22` on a mobile app.

None of that buys anything. JCS is RFC 8785 and frozen; `canonicalize` 2.1.0 and 5.0.0 produce byte-identical output across every case tested, including a real delegated ZCAP. The 3.x→5.x majors were packaging changes, not algorithm changes. This is forty lines of settled algorithm that produce the exact bytes we sign, so owning them is better than inheriting another project's packaging decisions.

`canonicalize` stays as a **dev** dependency and the vendored implementation is differentially tested against it on every CI run, so equivalence with the reference is proven rather than assumed. The existing cross-implementation fixture — which pins `hashEddsaJcs2022` byte-for-byte against CrMS's Python signer — still passes unchanged, which is the real evidence that the signed bytes did not move.

`jcs.ts` is duplicated into both packages, because a resource server must not depend on the client. A test asserts the two files are literally identical, so a drift fails at build time rather than as a verification failure between the two packages.

Also considered and rejected: `json-canonicalize@3`, which is dual-format and current but emits a bare `undefined` for symbol-valued properties, producing output that is not valid JSON. There is now a test asserting our output always parses.
