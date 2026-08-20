# CASE module

Raw [1EdTech CASE 1.1](https://www.imsglobal.org/spec/case/v1p1) vocabulary as a `GraphqlModule` — `cfDocuments`, `cfDocument`, `cfPackage`, `cfItem`, `cfItemTypes`, `cfItems`. This is the honest, unshaped CASE data straight off a go-case server, for browsing what frameworks/items exist. It does **not** know about College/Program, credentials, or anything product-specific — that opinionated shape (and the `packageId`/`framework`/`itemType` mapping into it) stays in the consumer (`digicred-crms`'s `catalog-graphql`).

See the [package README](../../README.md) for `GraphqlModule`/`composeModules`/`attachResolvers` and how `checkInvocation`'s `allowedAction` attenuation applies to these fields the same as any other.

## Install / use

```ts
import { buildSchema } from 'graphql'
import { attachResolvers, authModule, caseModule, composeModules } from '@digicred/did-graphql-server'

const composed = composeModules([authModule, caseModule()])
const schema = buildSchema(composed.sdl)
attachResolvers(schema, composed.resolvers)
```

`caseModule({ caseConfig })`'s `caseConfig` argument is accepted but unused today — every resolver reads `context.caseConfig` per request instead (see [Resolver context](#resolver-context)), so pass a `CaseConfig` there if you want an object-level default; it isn't required.

## `CaseConfig`

```ts
interface CaseConfig {
  baseUrl: string      // go-case base URL, e.g. https://go-case-digicred-sandbox.up.railway.app
  packageId: string    // this deployment's default package (Query.cfDocuments/cfPackage/cfItem/... still take any id — see Query fields)
  apiKey?: string      // sent as `Authorization: Bearer <key>` if set — go-case's own read routes need no auth (verified against its source), some deployments front it with a key anyway
  ttlMs?: number       // package-fetch cache TTL, default 5 minutes — see Caching
  fetchImpl?: typeof fetch // swap HTTP (tests)
}
```

## Query fields

| Field | Args | Returns | Notes |
|-------|------|---------|-------|
| `cfDocuments` | `limit`, `offset` | `CFDocumentResults!` | Every framework on the server. Real go-case pagination (`X-Total-Count` header), not client-side slicing. |
| `cfDocument` | `id: ID!` | `CFDocument` | One framework's own metadata, from any package on the server — not scoped to `config.packageId`. |
| `cfPackage` | `id: ID!` | `CFPackage` | Framework metadata + every `CFItem` + every `CFAssociation`, in one response. go-case has no pagination on this route — see [Caching](#caching). |
| `cfItem` | `id: ID!` | `CFItem` | One item by id, from any framework on the server (go-case's own `/CFItems/{id}` — not package-scoped). |
| `cfItemTypes` | `packageId`, `framework` | `[CFItemTypeCount!]!` | Every distinct `CFItemType` within one framework and how many items use each, sorted most-common-first. Lets a client discover what's in an unfamiliar framework without fetching every item. |
| `cfItems` | `packageId`, `framework`, `itemType`, `limit`, `offset` | `CFItemResults!` | Every item within one framework, paginated. Unlike `cfPackage`, only the requested page is returned — go-case itself has no item-level pagination (see `client.ts`'s top comment), so this slices the cached whole-package fetch. `itemType` filters to one `CFItemType` **before** slicing — `totalCount` reflects the filtered count, not the whole framework. Use `cfItemTypes` first to discover which values exist. |

`cfItemTypes`/`cfItems` both resolve their target framework the same way (`resolvePackageId`):

- Neither arg given → `config.packageId` (this deployment's default).
- `packageId` given → used as-is.
- `framework` given (no `packageId`) → resolved by matching `CFDocument.title` exactly via `cfDocuments`. Throws `FRAMEWORK_NOT_FOUND` if no title matches, `FRAMEWORK_AMBIGUOUS` if more than one framework shares that title (titles are **not** guaranteed unique on a real server) — the error message lists the candidate ids so the caller can retry with `packageId` instead.
- Both given → `packageId` wins.

## Types

`CFURIReference` (`identifier`, `title`, `uri`) is the shape go-case embeds wherever one CASE resource points to another — `CFDocumentURI`, `CFItemTypeURI`, `licenseURI`, `CFPackageURI`, `originNodeURI`, `destinationNodeURI`.

`CFDocument`, `CFItem`, `CFAssociation`, `CFPackage` mirror go-case's own serialized JSON field names exactly (see `client.ts`) rather than inventing parallel synonyms. `CFItem.extensions` is free-form, arbitrary per framework — the CASE 1.1 spec's own extensibility mechanism, not a DigiCred one — exposed as the `JSON` scalar (`jsonScalar` in `resolvers.ts`; a plain pass-through `serialize`/`parseValue`, plus a literal-AST walker for the rare inline-object-literal case). This module makes no assumption about what's inside it or what namespace keys it uses — that's entirely a consumer convention (e.g. `catalog-graphql`'s frameworks happen to use `ext:ctdl`/`ext:digicred`; see its `caseData.ts`).

`CFItemType` is a plain string, not a fixed CASE 1.1 enum (optionally backed by `CFItemTypeURI`, itself just another `CFURIReference`) — a framework can name its own items whatever makes sense (`"Program"`, `"College"`, `"Competency"`, `"Category"`, …); this module makes no assumption about which values a given framework uses.

## Resolver context

Every resolver expects, on the GraphQL `context` argument:

```ts
interface CaseResolverContext {
  zcapConfig: ZcapServerConfig
  payload: InvocationHeaderPayload | null
  rawQuery: string      // the literal request document — checked against allowedAction
  caseConfig: CaseConfig
}
```

Same shape `checkInvocation`/`requireAuthorizedQuery` use elsewhere in this package — nothing CASE-specific about the authorization step itself, only the `caseConfig` addition.

## Caching

`cfPackage`/`cfItemTypes`/`cfItems` all resolve to the *same* in-memory package cache (`client.ts`'s `packageCache`, keyed by `packageId`, default 5-minute TTL via `CaseConfig.ttlMs`) — go-case has no server-side item search/filter within a package, so the only way to answer "what item types exist" or "give me page 3 of items" is to fetch the whole package once (Wyoming Higher Education's is ~13MB; Wyoming K-12's is ~31k items) and slice/count in memory. `cfDocuments`/`cfDocument`/`cfItem` are real per-resource go-case endpoints with their own pagination/lookup, so they bypass this cache entirely — they're never large enough to need it.

`packageCache` is a bounded LRU (`PACKAGE_CACHE_MAX_ENTRIES`, 12 entries) on top of the TTL — package sizes vary hugely, so an unbounded cache on a server hosting many more frameworks than exist today could otherwise pin every large package in memory at once. This bounds entry *count*, not total bytes; there's no byte-size budget.

`resolveFrameworkPackageId` (used whenever `framework` is passed instead of `packageId`) has its own separate cache — `queries.ts`'s `frameworkPackageIdCache`, keyed by `(baseUrl, framework title)`, same 5-minute default TTL — so repeated framework-scoped calls don't each re-fetch `GET /CFDocuments?limit=1000` just to re-resolve a title that hasn't changed.

`clearCasePackageCache()` drops every cached package immediately; `clearFrameworkPackageIdCache()` drops every cached title→packageId resolution. Tests call both between cases so a mutated mock response, or a re-registered framework title, doesn't leak into the next assertion.

There is no cross-process cache for either — each server instance holds its own in memory. A multi-instance deployment fetches each package/title once per instance, not once total.

## Pagination limits

`cfItems`: `limit` is clamped to `CF_ITEMS_MAX_LIMIT` (200), defaulting to `CF_ITEMS_DEFAULT_LIMIT` (50) when omitted. `offset` has no upper bound (slicing past the end just returns an empty page with the real `totalCount`). `cfDocuments`' `limit`/`offset` are passed straight through to go-case's own query string — this module does not re-clamp them.

## Relationship to catalog-graphql

`digicred-crms`'s `catalog-graphql` service depends on this module directly — `composeModules([authModule, caseModule()])` spliced alongside its own College/Program-specific SDL (`schema.ts`), which is the only place that opinionated shape (and `packageId`/`framework`/`itemType` mapping into it) lives. There is no separate hand-duplicated CASE vocabulary there anymore.

That dependency is **vendored** into `catalog-graphql/vendor/did-graphql-server/`, not a live `file:` path to this repo — see that service's own README for why (a Docker/Railway build only has one repo's checkout) and its `scripts/sync-vendor.sh` for keeping the vendored copy current after a change here.
