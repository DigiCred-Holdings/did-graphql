---
'@digicredholdingsinc/did-graphql-server': patch
---

`allowedAction` matching now requires every operation in a GraphQL document to be allowed, not just the first. Previously a document holding a granted operation followed by an ungranted one passed the check, and the host's `operationName` could then select the ungranted one. No capability needs reissuing; this only narrows matching back to what was granted.
