---
'@digicredholdingsinc/did-graphql-server': minor
---

CASE client: concurrent requests for the same uncached package now share one upstream fetch. Framework titles are resolved against a shared snapshot of the full CFDocuments listing (every page, not just the first 1000), so unknown titles no longer each trigger an upstream request.

New `CaseConfig` options:
- `maxCachedPackages` sets the package cache size (default 12).
- `fetchTimeoutMs` bounds every upstream request (default 60 seconds), so a stalled fetch can't block the callers sharing it.

Behaviour changes for consumers:
- A newly published or renamed framework can be "not found" by title for up to 30 seconds, while lookups use the cached listing snapshot.
- CASE caches are now partitioned by `baseUrl` + `apiKey` instead of keyed by package id alone. Configs with different keys no longer share cached responses, which lowers the hit rate for consumers using several keys against one server.
