---
'@digicredholdingsinc/did-graphql-server': minor
---

CASE client: concurrent requests for the same uncached package now share one upstream fetch. Framework titles are resolved against a shared snapshot of the full CFDocuments listing (every page, not just the first 1000, including on servers that cap the page size), so unknown titles no longer each trigger an upstream request. Listing pagination is bounded: it stops at a stated total, an empty page, a page with nothing new, or 200 pages.

New `CaseConfig` options:
- `maxCachedPackages` sets the package cache size (default 12).
- `fetchTimeoutMs` bounds every upstream request (default 60 seconds; clamped to 2^31-1 ms), so a stalled fetch can't block the callers sharing it. It's a total deadline for response and body, per request.

Behaviour changes for consumers:
- A newly published or renamed framework can be "not found" by title for up to 30 seconds, while lookups use the cached listing snapshot.
- CASE caches are now partitioned by `baseUrl` + `apiKey` instead of keyed by package id alone. Configs with different keys no longer share cached responses, which lowers the hit rate for consumers using several keys against one server.

`getCFDocuments` also returns `totalCountKnown`, false when the server sent no usable `X-Total-Count` (in which case `totalCount` is the page length, as before).
