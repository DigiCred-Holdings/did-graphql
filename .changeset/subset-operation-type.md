---
"@digicredholdingsinc/did-graphql-server": patch
---

Fix a privilege escalation in field-subset matching: a capability granting a query authorized the same-named mutation.

`allowedAction` matching has two paths. The exact path compares document text and was never affected — the operation keyword is part of what it compares. The **field-subset** fallback parsed each document and compared root fields and their nested field names, but never read the operation type. So a capability granting `query Thing { thing { a b } }` also authorized `mutation Thing { thing { a b } }`, wherever a schema exposes the same name on both `Query` and `Mutation`. A read-only grant permitted a write.

Subset matching now requires the operation types to match. Narrowing a granted mutation still works — the fix constrains which entries a document can match, not whether mutations can attenuate. An anonymous `{ ... }` counts as a query, per GraphQL's own default.

No capability needs reissuing. This only ever widened what an existing capability authorized, so the fix can only narrow it back to what was intended.
