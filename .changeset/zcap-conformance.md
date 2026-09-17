---
"@digicredholdingsinc/did-graphql-server": minor
---

Stop ignoring `caveat` and `capabilityChain`. Both are inside the delegation signature, so both are authorization-relevant, and both were previously accepted and never read.

**`caveat` now fails closed.** A caveat is a signed *restriction*, so honouring a capability while ignoring its caveat grants strictly more than the delegator intended — the one direction a verifier must not err in. This library evaluates no caveat types, because it attenuates by literal query document instead, so any caveat at all is unevaluable here and is refused as `CAVEAT_UNSUPPORTED`. `allowUnsupportedCaveats: true` accepts them, for a deployment that knows its caveats are advisory.

**`capabilityChain` is now checked** against the resolved root when present. A capability could previously assert one chain while being verified against another. A chain longer than root → leaf is refused outright rather than verified one link deep and trusted for the rest, surfacing as `CAPABILITY_CHAIN_MISMATCH`.

Neither changes behaviour for capabilities this system already issues: the signer has always emitted a conformant single-entry `capabilityChain`, and nothing issues caveats. There is now a test pinning that, so a regression in the signer surfaces rather than passing silently.

Also documents the three places this library deliberately diverges from the spec — HTTP Signatures for the invocation proof, no `action` header parameter, and no root-zcap invocation — so they read as decisions rather than omissions.
