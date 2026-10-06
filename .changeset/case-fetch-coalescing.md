---
'@digicredholdingsinc/did-graphql-server': minor
---

CASE client: concurrent requests for the same uncached package now share one upstream fetch. The package cache size can be set with the new `CaseConfig.maxCachedPackages` option (default 12). Framework titles are resolved against a shared 30-second snapshot of the CFDocuments listing, so unknown titles no longer each trigger an upstream request.
