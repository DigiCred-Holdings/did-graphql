import { GraphQLScalarType, type GraphQLFieldConfig, type GraphQLSchema } from 'graphql'

export type ResolverFn = (...args: any[]) => unknown

export type ResolverMap = Record<string, Record<string, ResolverFn | object> | GraphQLScalarType>

export interface GraphqlModule {
  name: string
  /** Extra types (`type Zcap`, `type CFDocument`, …). No `type Query`. */
  typeDefs: string
  /** Fields spliced into `type Query`. */
  queryFields: string
  resolvers: ResolverMap
  /** GraphiQL / sandbox `allowedAction` documents. */
  defaultQueries: string[]
}

export interface ComposedModules {
  /** Concatenated extra types (no Query). */
  typeDefs: string
  /** Concatenated Query fields. */
  queryFields: string
  /** `typeDefs` + `type Query { queryFields }`. */
  sdl: string
  resolvers: ResolverMap
  defaultQueries: string[]
}

export function composeModules(modules: GraphqlModule[]): ComposedModules {
  const typeDefs = modules.map((m) => m.typeDefs.trim()).filter(Boolean).join('\n\n')
  const queryFields = modules.map((m) => m.queryFields.trim()).filter(Boolean).join('\n')
  const defaultQueries = modules.flatMap((m) => m.defaultQueries)
  const resolvers: ResolverMap = {}
  for (const m of modules) {
    for (const [typeName, fields] of Object.entries(m.resolvers)) {
      // A GraphQLScalarType resolver entry (e.g. JSON) is a real class
      // instance — spreading it into a plain object below loses its
      // prototype (toConfig/toJSON/[Symbol.toStringTag], the very
      // members TS flags as missing), so attachResolvers'
      // `fields instanceof GraphQLScalarType` check would then always
      // fail and silently skip wiring serialize/parseValue/
      // parseLiteral onto the schema. Keep the instance as-is instead
      // of merging into it.
      if (fields instanceof GraphQLScalarType) {
        resolvers[typeName] = fields
        continue
      }
      const existing = resolvers[typeName]
      resolvers[typeName] = { ...(existing instanceof GraphQLScalarType ? undefined : existing), ...fields }
    }
  }
  return {
    typeDefs,
    queryFields,
    sdl: `${typeDefs}\n\ntype Query {\n${queryFields}\n}`,
    resolvers,
    defaultQueries,
  }
}

/**
 * Wire a `ResolverMap` onto a `buildSchema()` result — Query/type
 * fields plus custom scalars (`JSON`).
 */
export function attachResolvers(schema: GraphQLSchema, resolvers: ResolverMap): void {
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName)
    if (!type) continue

    if (type instanceof GraphQLScalarType && fields instanceof GraphQLScalarType) {
      Object.assign(type, {
        serialize: fields.serialize.bind(fields),
        parseValue: fields.parseValue.bind(fields),
        parseLiteral: fields.parseLiteral.bind(fields),
      })
      continue
    }

    if (fields instanceof GraphQLScalarType || !('getFields' in type)) continue
    const typeFields = (type as { getFields(): Record<string, GraphQLFieldConfig<unknown, unknown>> }).getFields()
    for (const [fieldName, resolveFn] of Object.entries(fields)) {
      if (typeFields[fieldName] && typeof resolveFn === 'function') {
        ;(typeFields[fieldName] as { resolve?: unknown }).resolve = resolveFn
      }
    }
  }
}
