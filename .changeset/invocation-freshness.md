---
"@digicredholdingsinc/did-graphql-server": minor
---

Reject replayed invocations: `proof.created` is now checked against a freshness window.

An invocation proof binds the `invocationTarget` and the exact query text, so a captured header could never be pointed at another endpoint or reused for a different query. It did not bind **time**. The only deadline was the *capability's* `expires` — months out in real deployments — so anyone who captured one header could replay that one query against that one endpoint for the whole of that period. TLS was the only thing preventing capture.

`proof.created` is inside the signed proof options, so it cannot be adjusted by whoever captured the header. It is now checked against `invocationMaxAgeSeconds` (default 300) with `invocationClockSkewSeconds` (default 60) of tolerance in both directions, since client clocks run fast about as often as slow. Rejections surface as `INVOCATION_STALE` rather than `PROOF_INVALID`, because a replayed header and a forged one call for different responses.

A missing or unparseable `created` fails closed. Every signer in use sets it, so its absence is either a broken client or an attempt to opt out of the window.

**This is a behaviour change.** A client whose clock is off by more than the window will start failing where it previously succeeded. Fix the clock rather than widening the window; `invocationMaxAgeSeconds: 0` restores the old behaviour if you need to unblock first.

This closes the gap in the way that needs no changes outside this library. The ZCAP spec's own answer is HTTP Signatures, whose covered `date` component does the same job — adopting that would mean changing the wallet signer, ACA-Py and companion-app, and is a separate decision.
