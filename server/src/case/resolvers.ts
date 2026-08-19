import { GraphQLScalarType, Kind, type ValueNode } from 'graphql'

import type { InvocationHeaderPayload, ZcapServerConfig } from '../zcap.js'
import { requireAuthorizedQuery } from '../zcap.js'
import type { CaseConfig } from './client.js'
import { getCFDocument, getCFDocuments, getCFItem, getCFPackage } from './client.js'
import { getCFItemTypeCounts, getCFItems } from './queries.js'

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
  },
}
