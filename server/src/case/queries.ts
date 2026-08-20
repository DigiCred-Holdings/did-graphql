import { GraphQLError } from 'graphql'

import type { CaseConfig, CFItem } from './client.js'
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
