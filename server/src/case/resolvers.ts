import { GraphQLScalarType, Kind, type ValueNode } from 'graphql'

import type { InvocationHeaderPayload, ZcapServerConfig } from '../zcap.js'
import { requireAuthorizedQuery } from '../zcap.js'
import type { CaseConfig, CFAssociationEndpointRef } from './client.js'
import { getCFDocument, getCFDocuments, getCFItem, getCFItemFromCachedPackage, getCFPackage } from './client.js'
import { getCFAssociations, getCFItemTypeCounts, getCFItems } from './queries.js'

export interface CaseResolverContext {
  zcapConfig: ZcapServerConfig
  payload: InvocationHeaderPayload | null
  rawQuery: string
  caseConfig: CaseConfig
}

function parseLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value)
    case Kind.NULL:
      return null
    case Kind.LIST:
      return ast.values.map(parseLiteral)
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((f) => [f.name.value, parseLiteral(f.value)]))
    default:
      return null
  }
}

export const jsonScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON (CFItem.extensions).',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral,
})

export const caseResolvers = {
  JSON: jsonScalar,
  CFAssociationEndpoint: {
    item: async (parent: CFAssociationEndpointRef, _args: unknown, context: CaseResolverContext) => {
      // No separate authorization check here — resolving this field only
      // ever happens as part of an already-authorized cfAssociations
      // query (the field-subset check already passed for the whole
      // operation before any field resolver runs), and it's the exact
      // same cfItem(id) lookup Query.cfItem itself does.
      //
      // _packageId (see getCFAssociations) is a same-package hint, not
      // a guarantee — most associations point within their own
      // package, but not all (e.g. a crosswalk pointing at a different
      // framework's element), and the hinted package might have aged
      // out of cache since. getCFItemFromCachedPackage only ever
      // returns non-null on a genuine cache hit (see its own doc
      // comment — it will NOT fetch an uncached package just to check),
      // so this always falls back to the real per-item lookup rather
      // than silently missing a cross-package or cache-cold reference.
      if (parent._packageId) {
        const cached = await getCFItemFromCachedPackage(context.caseConfig, parent._packageId, parent.identifier)
        if (cached) return cached
      }
      return getCFItem(context.caseConfig, parent.identifier)
    },
  },
  Query: {
    cfDocuments: async (
      _parent: unknown,
      args: { limit?: number; offset?: number },
      context: CaseResolverContext,
    ) => {
      await requireAuthorizedQuery(context.zcapConfig, context.payload, context.rawQuery, 'cfDocuments')
      const { documents, totalCount } = await getCFDocuments(context.caseConfig, args)
      return { items: documents, totalCount }
    },

    cfDocument: async (_parent: unknown, { id }: { id: string }, context: CaseResolverContext) => {
      await requireAuthorizedQuery(context.zcapConfig, context.payload, context.rawQuery, 'cfDocument')
      return getCFDocument(context.caseConfig, id)
    },

    cfPackage: async (_parent: unknown, { id }: { id: string }, context: CaseResolverContext) => {
      await requireAuthorizedQuery(context.zcapConfig, context.payload, context.rawQuery, 'cfPackage')
      return getCFPackage(context.caseConfig, id)
    },

    cfItem: async (_parent: unknown, { id }: { id: string }, context: CaseResolverContext) => {
      await requireAuthorizedQuery(context.zcapConfig, context.payload, context.rawQuery, 'cfItem')
      return getCFItem(context.caseConfig, id)
    },

    cfItemTypes: async (
      _parent: unknown,
      args: { packageId?: string; framework?: string },
      context: CaseResolverContext,
    ) => {
      await requireAuthorizedQuery(context.zcapConfig, context.payload, context.rawQuery, 'cfItemTypes')
      return getCFItemTypeCounts(context.caseConfig, args)
    },

    cfItems: async (
      _parent: unknown,
      args: { packageId?: string; framework?: string; itemType?: string; limit?: number; offset?: number },
      context: CaseResolverContext,
    ) => {
      await requireAuthorizedQuery(context.zcapConfig, context.payload, context.rawQuery, 'cfItems')
      return getCFItems(context.caseConfig, args)
    },

    cfAssociations: async (
      _parent: unknown,
      args: {
        packageId?: string
        framework?: string
        originId?: string
        destinationId?: string
        associationType?: string
        limit?: number
        offset?: number
      },
      context: CaseResolverContext,
    ) => {
      await requireAuthorizedQuery(context.zcapConfig, context.payload, context.rawQuery, 'cfAssociations')
      return getCFAssociations(context.caseConfig, args)
    },
  },
}
