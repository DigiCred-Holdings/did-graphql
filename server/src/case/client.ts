// Talks to the real go-case server. go-case has no server-side item
// search/filter within a package (confirmed against its actual routes)
// — the only way to get a package's items is the whole package in one
// response (tens of MB for a large framework), so package fetches
// are cached in memory rather than round-tripped per GraphQL query.
// CFDocuments (framework metadata) and CFItems (single competency
// lookups), by contrast, are real per-resource go-case endpoints with
// their own pagination/filtering — no equivalent caching needed there.

export interface CaseConfig {
  baseUrl: string
  /**
   * Default package for a query that gives neither packageId nor
   * framework. Optional, and better left unset: an implicit default
   * makes a query's answer depend on server config rather than on the
   * query, which is why a query giving neither now fails with
   * PACKAGE_ID_REQUIRED instead of quietly reading whatever this
   * points at. Prefer naming `framework`/`packageId` per query — this
   * stays for servers built around one framework.
   */
  packageId?: string
  /** Optional — go-case's own read routes need no auth (verified against its source), but some deployments front it with a key anyway. Sent as `Authorization: Bearer <key>` if set. */
  apiKey?: string
  /** How long to keep a fetched package before re-fetching. Defaults to 5 minutes. */
  ttlMs?: number
  /**
   * How many packages the in-memory cache holds before evicting the
   * least recently used. Defaults to 12; anything that isn't a finite
   * number >= 1 also means 12, and fractions round down. Size it to the number of
   * frameworks one request can touch, or a request spanning more
   * evicts its own packages and re-fetches them. The cache is shared
   * by every config in the process; the value in effect is the one
   * passed by whichever call stores a package.
   */
  maxCachedPackages?: number
  /**
   * How long one upstream request (response and body) may take before
   * it's abandoned. Defaults to 60 seconds. Concurrent callers share a
   * package or listing fetch, so a request that never settled would
   * otherwise block every later caller for that resource until restart.
   */
  fetchTimeoutMs?: number
  /** Swap HTTP (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/** The shape go-case embeds wherever one CASE resource points to another — CFDocumentURI, CFItemTypeURI, licenseURI, CFPackageURI, originNodeURI, destinationNodeURI, ... */
export interface CFURIReference {
  identifier: string
  title?: string
  uri?: string
}

/**
 * Same shape as CFURIReference, plus a same-package hint the GraphQL
 * layer attaches internally (see queries.ts's getCFAssociations) — NOT
 * part of the public schema, just a private field on the object handed
 * to CFAssociationEndpoint.item's resolver, so it can look the item up
 * in the already-cached package instead of a live per-row GET /CFItems/
 * {id} network call. The vast majority of associations point within
 * their own package, so this turns what used to be one live fetch per
 * returned row into a cache hit; only genuinely cross-package
 * references (e.g. an O*NET occupation crosswalk pointing at a
 * different framework's element) still fall back to the live fetch.
 */
export interface CFAssociationEndpointRef extends CFURIReference {
  _packageId?: string
}

/** The root framework-metadata object for one CASE package — see go-case's GET /ims/case/v1p1/CFDocuments{,/:id}. */
export interface CFDocument {
  identifier: string
  uri: string
  title: string
  creator?: string
  publisher?: string
  description?: string
  subject?: string[]
  language?: string
  version?: string
  adoptionStatus?: string
  statusStartDate?: string
  statusEndDate?: string
  officialSourceURL?: string
  notes?: string
  frameworkType?: string
  caseVersion?: string
  lastChangeDateTime?: string
  CFPackageURI?: CFURIReference
}

export interface CFItem {
  identifier: string
  uri?: string
  CFItemType: string
  CFItemTypeURI?: CFURIReference
  fullStatement?: string
  abbreviatedStatement?: string
  humanCodingScheme?: string
  alternativeLabel?: string
  listEnumeration?: string
  conceptKeywords?: string[]
  conceptKeywordsURI?: CFURIReference[]
  notes?: string
  language?: string
  educationLevel?: string[]
  subject?: string[]
  subjectURI?: CFURIReference[]
  statusStartDate?: string
  statusEndDate?: string
  licenseURI?: CFURIReference
  lastChangeDateTime?: string
  CFDocumentURI?: CFURIReference
  // Free-form, per-framework — the CASE 1.1 spec only says extensions
  // is arbitrary JSON keyed by namespace; it does not mandate which
  // namespaces exist. Consumers know their own frameworks' conventions
  // (a credential vocabulary under its own `ext:` namespace, say) — this
  // module stays generic rather than hardcoding one consumer's
  // namespace choices.
  extensions?: Record<string, unknown>
}

export interface CFAssociation {
  identifier: string
  uri?: string
  associationType: string
  lastChangeDateTime?: string
  CFDocumentURI?: CFURIReference
  originNodeURI: { identifier: string; title: string }
  destinationNodeURI: { identifier: string; title: string }
  /** Free-form, per-framework — e.g. importance/level on an O*NET requirement, skillLevel on a SCED->skill link. Same convention as CFItem.extensions. */
  extensions?: Record<string, unknown>
}

export interface CFPackage {
  CFDocument: CFDocument
  CFItems: CFItem[]
  CFAssociations: CFAssociation[]
  /** A controlled-vocabulary/lookup table — typically empty; no consumer needs its shape today. */
  CFDefinitions?: Record<string, unknown>
}

function http(config: CaseConfig): typeof fetch {
  return config.fetchImpl ?? fetch
}

function authHeaders(config: CaseConfig): Record<string, string> {
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}
}

function caseBaseUrl(config: CaseConfig): string {
  return `${config.baseUrl.replace(/\/$/, '')}/ims/case/v1p1`
}

// Every id/packageId this module interpolates into a URL path
// (CFDocuments/{id}, CFItems/{id}, CFPackages/{id}) MUST go through
// encodeURIComponent first — these values come straight from GraphQL
// arguments, which ZCAP authorization gates by query *shape*, not by
// the caller-supplied value of an ID variable. Without encoding, an id
// containing "/" or "?" could redirect the request to a different
// go-case path/query than the one this function name implies.
const DEFAULT_FETCH_TIMEOUT_MS = 60 * 1000

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

/**
 * One upstream request, response and body together, under
 * `CaseConfig.fetchTimeoutMs`. The timeout belongs to the request, not
 * to any caller, so it holds however many callers share the result.
 * It's raced rather than relying on the abort alone, so it settles
 * even with a `fetchImpl` that ignores the signal.
 */
async function upstream<T>(config: CaseConfig, url: string, read: (res: Response) => Promise<T>): Promise<T> {
  const timeoutMs = positiveOr(config.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`go-case request timed out after ${timeoutMs}ms: ${url}`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      http(config)(url, { headers: authHeaders(config), signal: controller.signal }).then(read),
      timedOut,
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function failed(res: Response): Promise<never> {
  throw new Error(`go-case request failed: ${res.status} ${await res.text().catch(() => '')}`)
}

async function fetchJson<T>(url: string, config: CaseConfig): Promise<T | null> {
  return upstream(config, url, async (res) => {
    if (res.status === 404) return null
    if (!res.ok) return failed(res)
    return (await res.json()) as T
  })
}

// Bounded to a max entry count, not just a TTL — package sizes vary
// hugely (a single framework can run to tens of thousands of items and
// tens of MB), so a server hosting many frameworks
// could otherwise pin every large package in memory at once, with only
// the TTL to (eventually) free any of it. This is a plain LRU by entry
// count, not a byte-size budget — good enough to cap how many packages
// are held at once without the complexity of estimating each one's
// actual size. Map's insertion order does the LRU bookkeeping: a
// delete+re-set on every read/write moves that entry to the end, so
// eviction (deleting Map's current first key) always drops the
// least-recently-touched package first.
const PACKAGE_CACHE_MAX_ENTRIES = 12
const packageCache = new Map<string, { package: CFPackage; fetchedAt: number }>()

// One shared fetch per package while it's in flight. Without this,
// N concurrent requests for the same cold package each fetch and parse
// the whole thing (tens of MB) — N copies in memory at once, for one
// result.
const packageInFlight = new Map<string, Promise<CFPackage | null>>()

/**
 * What every CASE cache in this module is partitioned by: the server
 * and the credential used to read it. Two configs sharing a cache
 * entry share a response, so configs with different `apiKey`s on the
 * same server must not — otherwise a caller with a bad key could be
 * served what a good key fetched, or a good key inherit a bad key's
 * 401. The key is used as-is rather than mapped to an id: the config
 * already holds it, and an id registry would have to outlive every
 * cache entry — growing without bound under rotating keys — whereas a
 * key embedded in the entries goes away when they do.
 */
export function caseCacheScope(config: CaseConfig): string {
  return JSON.stringify([config.baseUrl.replace(/\/$/, ''), config.apiKey ?? ''])
}

function packageCacheKey(config: CaseConfig, packageId: string): string {
  return JSON.stringify([caseCacheScope(config), packageId])
}

export function clearCasePackageCache(): void {
  packageCache.clear()
  packageInFlight.clear()
}

function getCachedPackage(key: string): { package: CFPackage; fetchedAt: number } | undefined {
  const hit = packageCache.get(key)
  if (hit) {
    packageCache.delete(key)
    packageCache.set(key, hit)
  }
  return hit
}

/**
 * A non-fetching peek: is `packageId` already cached and still within
 * TTL? Used by getCFItemFromCachedPackage's caller to decide whether
 * looking an item up "from cache" would actually be free (a genuine
 * cache hit) or would silently trigger a full package fetch just to
 * resolve one item — which, for a package that isn't already warm,
 * could be far more expensive than the single-item GET /CFItems/{id}
 * it exists to avoid (a large package alone can be tens of MB).
 */
export function isPackageCached(config: CaseConfig, packageId: string): boolean {
  const ttl = config.ttlMs ?? 5 * 60 * 1000
  const hit = packageCache.get(packageCacheKey(config, packageId))
  return !!hit && Date.now() - hit.fetchedAt < ttl
}

function cachePackage(config: CaseConfig, key: string, pkg: CFPackage): void {
  packageCache.delete(key)
  packageCache.set(key, { package: pkg, fetchedAt: Date.now() })
  while (packageCache.size > positiveOr(config.maxCachedPackages, PACKAGE_CACHE_MAX_ENTRIES)) {
    const oldest = packageCache.keys().next().value
    if (oldest !== undefined) packageCache.delete(oldest)
  }
}

async function fetchCFPackage(config: CaseConfig, packageId: string): Promise<CFPackage | null> {
  const ttl = config.ttlMs ?? 5 * 60 * 1000
  const key = packageCacheKey(config, packageId)
  const cached = getCachedPackage(key)
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.package

  const pending = packageInFlight.get(key)
  if (pending) return pending

  const url = `${caseBaseUrl(config)}/CFPackages/${encodeURIComponent(packageId)}`
  const fetching = fetchJson<CFPackage>(url, config)
    .then((pkg) => {
      // Only if this is still the registered fetch: one started before
      // clearCasePackageCache() mustn't overwrite what came after it.
      if (pkg && packageInFlight.get(key) === fetching) cachePackage(config, key, pkg)
      return pkg
    })
    .finally(() => {
      // A failure is shared by everyone already waiting, but not
      // remembered — the next request retries.
      if (packageInFlight.get(key) === fetching) packageInFlight.delete(key)
    })
  packageInFlight.set(key, fetching)
  return fetching
}

/** The default package this config names (`CaseConfig.packageId`). Throws if unset or not found on the server. */
export async function getCasePackage(config: CaseConfig): Promise<CFPackage> {
  if (!config.packageId) throw new Error(`CaseConfig.packageId is not set — no default package to fetch from ${config.baseUrl}`)
  const pkg = await fetchCFPackage(config, config.packageId)
  if (!pkg) throw new Error(`configured CaseConfig.packageId "${config.packageId}" not found on ${config.baseUrl}`)
  return pkg
}

/** Any package on the server by id. Unlike item list endpoints, returns everything in one response. */
export async function getCFPackage(config: CaseConfig, packageId: string): Promise<CFPackage | null> {
  return fetchCFPackage(config, packageId)
}

/** One framework's own metadata by id — GET /ims/case/v1p1/CFDocuments/{id}. */
export async function getCFDocument(config: CaseConfig, id: string): Promise<CFDocument | null> {
  const result = await fetchJson<{ CFDocument: CFDocument }>(`${caseBaseUrl(config)}/CFDocuments/${encodeURIComponent(id)}`, config)
  return result?.CFDocument ?? null
}

/** One CFItem by id, from any framework on the server — GET /ims/case/v1p1/CFItems/{id}. */
export async function getCFItem(config: CaseConfig, id: string): Promise<CFItem | null> {
  const result = await fetchJson<{ CFItem: CFItem }>(`${caseBaseUrl(config)}/CFItems/${encodeURIComponent(id)}`, config)
  return result?.CFItem ?? null
}

/**
 * Same lookup as getCFItem, but served from an already-cached package
 * instead of a live network round trip — an in-memory find() over a
 * package likely already fetched moments earlier in the same request
 * (see CFAssociationEndpoint.item's resolver). Deliberately checks
 * isPackageCached FIRST and returns null immediately on a miss, rather
 * than calling getCFPackage unconditionally: fetching an entire
 * not-yet-cached package (tens of MB for a large framework)
 * just to resolve one item would be far more expensive than the single
 * getCFItem call this exists to avoid — the caller falls back to that
 * live lookup whenever this returns null.
 */
export async function getCFItemFromCachedPackage(
  config: CaseConfig,
  packageId: string,
  id: string,
): Promise<CFItem | null> {
  if (!isPackageCached(config, packageId)) return null
  const pkg = await getCFPackage(config, packageId)
  return pkg?.CFItems.find((item) => item.identifier === id) ?? null
}

/** Every framework hosted on the go-case server — GET /ims/case/v1p1/CFDocuments. totalCount from X-Total-Count. */
export async function getCFDocuments(
  config: CaseConfig,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ documents: CFDocument[]; totalCount: number }> {
  const params = new URLSearchParams()
  if (opts.limit != null) params.set('limit', String(opts.limit))
  if (opts.offset != null) params.set('offset', String(opts.offset))
  const query = params.toString()
  const url = `${caseBaseUrl(config)}/CFDocuments${query ? `?${query}` : ''}`

  return upstream(config, url, async (res) => {
    if (!res.ok) return failed(res)
    const body = (await res.json()) as { CFDocuments: CFDocument[] }
    const totalCountHeader = res.headers.get('x-total-count')
    const totalCount = totalCountHeader ? Number(totalCountHeader) : body.CFDocuments.length
    return { documents: body.CFDocuments, totalCount }
  })
}
