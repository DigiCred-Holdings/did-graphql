---
"@digicredholdingsinc/did-graphql-server": minor
---

Accept `graphql` 17 as well as 16 — `"graphql": "^16.14.2 || ^17.0.0"`.

Dependabot proposed moving the declared range to `^17.0.2` outright. That would have been a breaking change for every consumer still on 16, in exchange for nothing: this package's entire `graphql` surface is `parse`, `Kind`, `GraphQLError`, `GraphQLScalarType` and a handful of AST types, all unchanged across the two majors. Widening the range instead lets consumers upgrade on their own schedule, and lets a consumer that already depends on `graphql` dedupe to a single instance rather than ending up with two — which matters more than usual here, since this package hands typeDefs and resolvers to the consumer's own schema.

CI now runs the full suite against both majors rather than only whichever the lockfile happens to pin, because a union range that is only ever exercised on one side is a claim rather than a guarantee.
