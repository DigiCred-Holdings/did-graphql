---
"@digicred-holdings/did-graphql-server": patch
---

`containsSchemaIntrospection` and `checkIntrospection` no longer throw on a non-string `query`.

0.5.0 added a substring precheck that skipped the parse for documents that cannot introspect — a real saving, since a host following the README calls this on every request. But it sat outside the `try/catch` that had made a bad input safe, so `query.includes('__schema')` threw a TypeError for anything that wasn't a string. A caller's `query` comes from a JSON body, where `{}` yields `undefined`: in an async request handler that TypeError is an unhandled rejection, which ends the **process**, not the request. One malformed body was enough to take a server down.

Both functions now return `false` / `{ ok: true }` for a non-string, since a non-string is not a document and cannot select anything; their parameters are typed `unknown` to match what a caller actually has. This is defense in depth, not a substitute for validating the body — the README's introspection section now spells out the check a host still owes, and the example server does it.
