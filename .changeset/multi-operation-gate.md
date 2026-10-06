---
'@digicredholdingsinc/did-graphql-server': patch
---

`allowedAction` matching now requires every operation in a GraphQL document to be allowed, not just the first. Previously a document holding a granted operation followed by an ungranted one passed the check, and the host's `operationName` could then select the ungranted one. No capability needs reissuing.

One request shape is newly accepted. When an `allowedAction` entry contains several operations, each one may now be sent on its own. This grants nothing new, since the entry's full document could already run any of them via `operationName`.
