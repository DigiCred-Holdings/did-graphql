import type { GraphqlModule } from '../modules.js'
import type { CaseConfig } from './client.js'
import { caseResolvers } from './resolvers.js'
import { CASE_DEFAULT_QUERIES, CASE_QUERY_FIELDS, CASE_TYPEDEFS } from './schema.js'

export type { CaseConfig, CFAssociation, CFDocument, CFItem, CFPackage, CFURIReference } from './client.js'
export {
  clearCasePackageCache,
  getCasePackage,
  getCFDocument,
  getCFDocuments,
  getCFItem,
  getCFPackage,
} from './client.js'
export type { CFItemsResult, CFItemTypeCount } from './queries.js'
export {
  clearFrameworkPackageIdCache,
  getCFItems,
  getCFItemTypeCounts,
  resolveFrameworkPackageId,
  resolvePackageId,
} from './queries.js'
export { CASE_DEFAULT_QUERIES, CASE_QUERY_FIELDS, CASE_TYPEDEFS } from './schema.js'
export { caseResolvers, jsonScalar } from './resolvers.js'

/**
 * Raw IMS CASE 1.1 GraphQL module (cfDocuments, cfPackage, cfItem, …).
 * Resolvers read `context.caseConfig`; pass `caseConfig` here only if
 * you want a default on the module object (not required).
 */
export function caseModule(_opts: { caseConfig?: CaseConfig } = {}): GraphqlModule {
  return {
    name: 'case',
    typeDefs: CASE_TYPEDEFS,
    queryFields: CASE_QUERY_FIELDS,
    resolvers: caseResolvers as GraphqlModule['resolvers'],
    defaultQueries: CASE_DEFAULT_QUERIES,
  }
}
