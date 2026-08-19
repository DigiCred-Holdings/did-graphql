import type { GraphqlModule } from './modules.js'
import { checkAuthOnly, type InvocationHeaderPayload, type ZcapServerConfig } from './zcap.js'

/**
 * Default diagnostic document. Not a production `allowedAction`.
 * Pair with `Query.zcap` from {@link AUTH_TYPEDEFS} / {@link AUTH_QUERY_FIELD}.
 */
export const AUTH_QUERY = 'query Auth { zcap { valid } }'

/**
 * `type Zcap` — splice into the resource server's SDL before `type Query`.
 * Extra fields on `checkAuthOnly`'s result (`reason`) are selectable too.
 */
export const AUTH_TYPEDEFS = /* GraphQL */ `
  """
  Presented ZCAP leaf, plus whether the resource server accepted the
  chain. Dev diagnostic only — Query.zcap is not part of allowedAction
  and requires no invocation proof. \`allowedAction\` is the ZCAP field
  name (an array), not \`allowedActions\`.
  """
  type Zcap {
    valid: Boolean!
    reason: String
    id: ID
    controller: String
    invocationTarget: String
    allowedAction: [String!]
    expires: String
  }
`

/** Field to include on `type Query` so \`query Auth { zcap { valid } }\` resolves. */
export const AUTH_QUERY_FIELD = /* GraphQL */ `
    """
    Dev-only diagnostic — NOT part of the production allowedAction
    surface. Echoes the presented leaf and sets \`valid\` from
    checkAuthOnly. No invocation proof is required. Invalid chains
    still return this object with \`valid: false\` so
    \`query Auth { zcap { valid } }\` always resolves.
    """
    zcap: Zcap!
`

export interface AuthResolverContext {
  zcapConfig: ZcapServerConfig
  payload: InvocationHeaderPayload | null
}

/**
 * `Query.zcap` resolver. Attach next to the resource server's other
 * Query fields. Context must expose `zcapConfig` and `payload`.
 */
export const authResolvers = {
  Query: {
    zcap(_parent: unknown, _args: unknown, context: AuthResolverContext): ReturnType<typeof checkAuthOnly> {
      return checkAuthOnly(context.zcapConfig, context.payload)
    },
  },
}

export const authModule: GraphqlModule = {
  name: 'auth',
  typeDefs: AUTH_TYPEDEFS,
  queryFields: AUTH_QUERY_FIELD,
  resolvers: authResolvers,
  defaultQueries: [AUTH_QUERY],
}
