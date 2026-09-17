---
"@digicredholdingsinc/did-graphql-client": minor
"@digicredholdingsinc/did-graphql-server": minor
---

Send the invocation in a `Capability-Invocation` header, encoded as the ZCAP spec's HTTP binding specifies.

A real deployment reached 9 named queries and its `x-zcap-invocation` header measured **9,724 bytes** — past the limit on both deployed hosts, which cut off between 8KB and 16KB. It failed badly: one proxy returns a bare `400`, surfacing in the wallet as "Graphql transport error: 400" rather than the `431 Request Header Fields Too Large` the other host correctly returns, so the cause reads as a GraphQL fault and is actually header size.

The spec already solves this. Its HTTP binding carries the capability by "serializing it to JSON, gzipping the result, and then base64url-encoding the gzipped JSON" — so compression here is not an optimization bolted on, it is what conformance requires. The same capability now encodes to **1,783 bytes**.

`allowedAction` is untouched: it is inside the delegation signature, and it must stay parseable GraphQL for the exact-match and field-subset gates and for the other implementations that check it. What changed is the transport encoding around the capability, which the verifier gunzips back to byte-identical JSON. Compressing the entries individually would have been both worse and more invasive — the nine queries share heavy token structure, so they are 918 bytes compressed together against 2,294 apart.

Also in this release:

- `InvocationHeaderTooLargeError`, thrown before any HTTP when the built header exceeds `maxHeaderBytes` (default 8192), naming the `allowedAction` count — because the proxy-side failure is so poorly signalled.
- HTTP 431 now produces an error naming the header and its size.
- `describeInvocationHeader` distinguishes an absent header from a truncated one. Both previously surfaced as "missing capability", which is precisely what made the original failure look like something else.
- The inflate is bounded (256KB out, 64KB in) — the server now decompresses attacker-controlled bytes, and an unbounded inflate there would be a memory-exhaustion vector.

**Upgrade servers before clients.** The server accepts the legacy `x-zcap-invocation` permanently, so an old client against a new server is fine; a client at this version against an older server fails on every request. `encodeInvocationHeader` / `decodeInvocationHeader` stay exported and deprecated.
