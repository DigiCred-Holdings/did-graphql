---
"@digicred-holdings/did-graphql-server": minor
---

Add `checkIntrospection` / `containsSchemaIntrospection`, closing an authorization gap: `checkInvocation` runs inside field resolvers, but `__schema`/`__type` are graphql-js built-ins with no resolver, so a document selecting only those reached no gate and was answered from the schema with **no capability present at all**. Data was never exposed, but the full API shape was — every type, field, and argument name.

`checkIntrospection(config, payload, query, policy?)` is a request-level check a host calls once before `graphql()`. Non-introspecting documents always pass, so it is safe to call unconditionally. Policies: `authorized` (default — any structurally valid, unexpired chain for this target, deliberately not `allowedAction` membership, since no real capability lists GraphiQL's introspection document), `public` (the previous behavior), and `off`.

`containsSchemaIntrospection` follows aliases, inline fragments, and named fragment spreads, so introspection hidden inside a fragment doesn't slip past. `__typename` is not treated as introspection.

**This is opt-in for existing consumers**: nothing changes until a host adds the call. A server that wants the old behavior explicitly can pass `'public'`.
