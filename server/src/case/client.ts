// Talks to the real go-case server. go-case has no server-side item
// search/filter within a package (confirmed against its actual routes)
// — the only way to get a package's items is the whole package in one
// response (~13MB for Wyoming Higher Education), so package fetches
// are cached in memory rather than round-tripped per GraphQL query.
// CFDocuments (framework metadata) and CFItems (single competency
// lookups), by contrast, are real per-resource go-case endpoints with
// their own pagination/filtering — no equivalent caching needed there.

export interface CaseConfig {
  baseUrl: string
  packageId: string
  /** Optional — go-case's own read routes need no auth (verified against its source), but some deployments front it with a key anyway. Sent as `Authorization: Bearer <key>` if set. */
  apiKey?: string
  /** How long to keep a fetched package before re-fetching. Defaults to 5 minutes. */
  ttlMs?: number
  /** Swap HTTP (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/** The shape go-case embeds wherever one CASE resource points to another — CFDocumentURI, CFItemTypeURI, licenseURI, CFPackageURI, originNodeURI, destinationNodeURI, ... */
export interface CFURIReference {
  identifier: string
  title?: string
  uri?: string
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
  // (e.g. digicred-crms's catalog-graphql reads `ext:ctdl`/
  // `ext:digicred` — see its caseData.ts) — this module stays generic
  // rather than hardcoding one consumer's namespace choices.
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
async function fetchJson<T>(url: string, config: CaseConfig): Promise<T | null> {
  const res = await http(config)(url, { headers: authHeaders(config) })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`go-case request failed: ${res.status} ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as T
}

// Bounded to a max entry count, not just a TTL — package sizes vary
// hugely (Wyoming K-12 alone is ~31k items; Wyoming Higher Education's
// is ~13MB), so a server hosting many more frameworks than exist today
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

export function clearCasePackageCache(): void {
  packageCache.clear()
}

function getCachedPackage(packageId: string): { package: CFPackage; fetchedAt: number } | undefined {
  const hit = packageCache.get(packageId)
  if (hit) {
    packageCache.delete(packageId)
    packageCache.set(packageId, hit)
  }
  return hit
}

function cachePackage(packageId: string, pkg: CFPackage): void {
  packageCache.delete(packageId)
  packageCache.set(packageId, { package: pkg, fetchedAt: Date.now() })
  if (packageCache.size > PACKAGE_CACHE_MAX_ENTRIES) {
    const oldest = packageCache.keys().next().value
    if (oldest !== undefined) packageCache.delete(oldest)
  }
}

async function fetchCFPackage(config: CaseConfig, packageId: string): Promise<CFPackage | null> {
  const ttl = config.ttlMs ?? 5 * 60 * 1000
  const cached = getCachedPackage(packageId)
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.package

  const pkg = await fetchJson<CFPackage>(`${caseBaseUrl(config)}/CFPackages/${encodeURIComponent(packageId)}`, config)
  if (pkg) cachePackage(packageId, pkg)
  return pkg
}

/** The package this service is configured against (CASE_PACKAGE_ID). Throws if missing. */
export async function getCasePackage(config: CaseConfig): Promise<CFPackage> {
  const pkg = await fetchCFPackage(config, config.packageId)
  if (!pkg) throw new Error(`configured CASE_PACKAGE_ID "${config.packageId}" not found on ${config.baseUrl}`)
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

  const res = await http(config)(url, { headers: authHeaders(config) })
  if (!res.ok) {
    throw new Error(`go-case request failed: ${res.status} ${await res.text().catch(() => '')}`)
  }
  const body = (await res.json()) as { CFDocuments: CFDocument[] }
  const totalCountHeader = res.headers.get('x-total-count')
  const totalCount = totalCountHeader ? Number(totalCountHeader) : body.CFDocuments.length
  return { documents: body.CFDocuments, totalCount }
}
