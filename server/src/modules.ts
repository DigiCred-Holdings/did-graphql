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

/**
 * Two resolver maps naming the same type AND the same field on it is
 * never a meaningful merge — there is no ordering the author could
 * have intended, and the loser vanishes with no error. That matters
 * because the loser may be the resolver that calls `checkInvocation`:
 * the SDL still advertises a gated field while the wired resolver
 * checks nothing, and the failure is silent and *open* (data flows)
 * rather than closed. So this throws instead of merging.
 */
export class ResolverCollisionError extends Error {}

/**
 * Merge resolver maps, refusing any type+field collision.
 *
 * Use this instead of spreading maps together — `{ ...composed.resolvers,
 * Query: { ...composed.resolvers.Query, ...mine } }` silently lets the
 * last spread win, which is the footgun above. A deliberate override
 * is still possible by spreading by hand; it just has to be deliberate.
 *
 * `label` names each map in the error message ("module 'case'", "map
 * #2"), so a collision says which two sources disagreed.
 */
export function mergeResolvers(...maps: (ResolverMap | { label: string; resolvers: ResolverMap })[]): ResolverMap {
  const out: ResolverMap = {}
  /** typeName -> fieldName -> label of whoever provided it */
  const provenance = new Map<string, Map<string, string>>()

  maps.forEach((entry, index) => {
    const isLabeled = 'label' in entry && 'resolvers' in entry
    const label = isLabeled ? (entry as { label: string }).label : `map #${index + 1}`
    const map = isLabeled ? (entry as { resolvers: ResolverMap }).resolvers : (entry as ResolverMap)

    for (const [typeName, fields] of Object.entries(map)) {
      const owners = provenance.get(typeName) ?? new Map<string, string>()

      // A GraphQLScalarType resolver entry (e.g. JSON) is a real class
      // instance — spreading it into a plain object loses its prototype
      // (toConfig/toJSON/[Symbol.toStringTag], the very members TS flags
      // as missing), so attachResolvers' `fields instanceof
      // GraphQLScalarType` check would then always fail and silently
      // skip wiring serialize/parseValue/parseLiteral onto the schema.
      // Keep the instance as-is instead of merging into it.
      if (fields instanceof GraphQLScalarType) {
        const previous = owners.get('*scalar*')
        if (previous) {
          throw new ResolverCollisionError(
            `${label} redeclares the custom scalar ${typeName}, already provided by ${previous}`,
          )
        }
        owners.set('*scalar*', label)
        provenance.set(typeName, owners)
        out[typeName] = fields
        continue
      }

      for (const fieldName of Object.keys(fields)) {
        const previous = owners.get(fieldName)
        if (previous) {
          throw new ResolverCollisionError(
            `${label} redeclares ${typeName}.${fieldName}, already provided by ${previous} — ` +
              'a silently shadowed resolver can drop an authorization check; merge deliberately if you meant to override it',
          )
        }
        owners.set(fieldName, label)
      }
      provenance.set(typeName, owners)

      const existing = out[typeName]
      out[typeName] = { ...(existing instanceof GraphQLScalarType ? undefined : existing), ...fields }
    }
  })

  return out
}

export function composeModules(modules: GraphqlModule[]): ComposedModules {
  const typeDefs = modules.map((m) => m.typeDefs.trim()).filter(Boolean).join('\n\n')
  const queryFields = modules.map((m) => m.queryFields.trim()).filter(Boolean).join('\n')
  const defaultQueries = modules.flatMap((m) => m.defaultQueries)
  const resolvers = mergeResolvers(...modules.map((m) => ({ label: `module '${m.name}'`, resolvers: m.resolvers })))
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
