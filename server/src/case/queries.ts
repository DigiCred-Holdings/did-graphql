import { GraphQLError } from 'graphql'

import type { CaseConfig, CFAssociation, CFItem } from './client.js'
import { getCFDocuments, getCFPackage } from './client.js'

// Every framework-scoped cfItems/cfItemTypes call that passes
// `framework` instead of `packageId` used to re-fetch
// GET /CFDocuments?limit=1000 fresh, every time, just to resolve a
// title it had almost certainly already resolved on the previous call
// — titles don't change. Cached per (baseUrl, framework title), same
// TTL default as packageCache, since both are answering "what does
// this server currently say," not permanent facts.
const FRAMEWORK_PACKAGE_ID_TTL_MS = 5 * 60 * 1000
const frameworkPackageIdCache = new Map<string, { packageId: string; cachedAt: number }>()

export function clearFrameworkPackageIdCache(): void {
  frameworkPackageIdCache.clear()
}

/**
 * Resolves a human-friendly framework title to its packageId.
 * Titles are NOT unique — ambiguous matches throw with candidate ids.
 */
export async function resolveFrameworkPackageId(config: CaseConfig, framework: string): Promise<string> {
  const cacheKey = `${config.baseUrl}::${framework}`
  const cached = frameworkPackageIdCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < FRAMEWORK_PACKAGE_ID_TTL_MS) return cached.packageId

  const { documents } = await getCFDocuments(config, { limit: 1000 })
  const matches = documents.filter((d) => d.title === framework)

  if (matches.length === 0) {
    throw new GraphQLError(`no CASE framework found with title "${framework}" — see cfDocuments for the real titles`, {
      extensions: { code: 'FRAMEWORK_NOT_FOUND' },
    })
  }
  if (matches.length > 1) {
    const ids = matches.map((d) => d.identifier).join(', ')
    throw new GraphQLError(
      `"${framework}" matches ${matches.length} frameworks (${ids}) — titles aren't guaranteed unique on this server; pass packageId instead to pick one`,
      { extensions: { code: 'FRAMEWORK_AMBIGUOUS' } },
    )
  }
  const packageId = matches[0]!.identifier
  frameworkPackageIdCache.set(cacheKey, { packageId, cachedAt: Date.now() })
  return packageId
}

/** packageId wins if both packageId and framework are given. */
export async function resolvePackageId(
  config: CaseConfig,
  opts: { packageId?: string; framework?: string },
): Promise<string> {
  return opts.packageId ?? (opts.framework ? await resolveFrameworkPackageId(config, opts.framework) : config.packageId)
}

export interface CFItemTypeCount {
  itemType: string
  count: number
}

export async function getCFItemTypeCounts(
  config: CaseConfig,
  opts: { packageId?: string; framework?: string } = {},
): Promise<CFItemTypeCount[]> {
  const packageId = await resolvePackageId(config, opts)
  const pkg = await getCFPackage(config, packageId)
  if (!pkg) throw new GraphQLError(`CASE package "${packageId}" not found`, { extensions: { code: 'PACKAGE_NOT_FOUND' } })

  const counts = new Map<string, number>()
  for (const item of pkg.CFItems) {
    counts.set(item.CFItemType, (counts.get(item.CFItemType) ?? 0) + 1)
  }
  return [...counts.entries()].map(([itemType, count]) => ({ itemType, count })).sort((a, b) => b.count - a.count)
}

export interface CFItemsResult {
  items: CFItem[]
  totalCount: number
}

const CF_ITEMS_MAX_LIMIT = 200
const CF_ITEMS_DEFAULT_LIMIT = 50

export async function getCFItems(
  config: CaseConfig,
  opts: { packageId?: string; framework?: string; itemType?: string; limit?: number; offset?: number } = {},
): Promise<CFItemsResult> {
  const packageId = await resolvePackageId(config, opts)
  const pkg = await getCFPackage(config, packageId)
  if (!pkg) throw new GraphQLError(`CASE package "${packageId}" not found`, { extensions: { code: 'PACKAGE_NOT_FOUND' } })

  // Filtered BEFORE slicing/totalCount, same as cfItemTypes' own counts
  // — totalCount reflects "how many match itemType", not the whole
  // package, so a client paging through one itemType sees the right
  // page count. See Query.cfItemTypes for discovering which itemType
  // values exist in an unfamiliar framework first.
  const matching = opts.itemType ? pkg.CFItems.filter((item) => item.CFItemType === opts.itemType) : pkg.CFItems

  const start = opts.offset ?? 0
  const limit = Math.min(opts.limit ?? CF_ITEMS_DEFAULT_LIMIT, CF_ITEMS_MAX_LIMIT)
  return { items: matching.slice(start, start + limit), totalCount: matching.length }
}

export interface CFAssociationsResult {
  items: CFAssociation[]
  totalCount: number
}

const CF_ASSOCIATIONS_MAX_LIMIT = 200
const CF_ASSOCIATIONS_DEFAULT_LIMIT = 50

// Same in-memory-package-then-filter pattern as getCFItems above — go-case
// itself has no server-side association filter, so this filters the
// already-cached full package (see client.ts's packageCache) rather than
// making a second round-trip. Some packages here are association-only
// crosswalks with no CFItems at all and a very large CFAssociations array
// (crosswalk-onet-requirements is 175k+) — filtering by originId/
// destinationId before slicing keeps a caller's actual page small even
// against those.
export async function getCFAssociations(
  config: CaseConfig,
  opts: {
    packageId?: string
    framework?: string
    originId?: string
    destinationId?: string
    associationType?: string
    limit?: number
    offset?: number
  } = {},
): Promise<CFAssociationsResult> {
  const packageId = await resolvePackageId(config, opts)
  const pkg = await getCFPackage(config, packageId)
  if (!pkg) throw new GraphQLError(`CASE package "${packageId}" not found`, { extensions: { code: 'PACKAGE_NOT_FOUND' } })

  let matching = pkg.CFAssociations
  if (opts.originId) matching = matching.filter((a) => a.originNodeURI.identifier === opts.originId)
  if (opts.destinationId) matching = matching.filter((a) => a.destinationNodeURI.identifier === opts.destinationId)
  if (opts.associationType) matching = matching.filter((a) => a.associationType === opts.associationType)

  const start = opts.offset ?? 0
  const limit = Math.min(opts.limit ?? CF_ASSOCIATIONS_DEFAULT_LIMIT, CF_ASSOCIATIONS_MAX_LIMIT)
  const page = matching.slice(start, start + limit)

  // Tag each endpoint with the package it came from — a same-package
  // hint for CFAssociationEndpoint.item's resolver, which uses it to
  // look the item up in this same already-fetched package (a cache hit,
  // since it's the package this very call just resolved) instead of a
  // live per-row GET /CFItems/{id}. New objects, not a mutation of
  // pkg.CFAssociations' own cached entries — those are shared across
  // every call against this cached package, and this field is a
  // read-time hint, not part of the CASE data itself.
  const tagged = page.map((a) => ({
    ...a,
    originNodeURI: { ...a.originNodeURI, _packageId: packageId },
    destinationNodeURI: { ...a.destinationNodeURI, _packageId: packageId },
  }))
  return { items: tagged, totalCount: matching.length }
}
