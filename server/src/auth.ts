import type { GraphqlModule } from './modules.js'
import { checkAuthOnly, type InvocationHeaderPayload, type ZcapServerConfig } from './zcap.js'

/**
 * Default diagnostic document. Not a production `allowedAction`.
 * Pair with `Query.auth.zcap` from {@link AUTH_TYPEDEFS} /
 * {@link AUTH_QUERY_FIELD}. Must stay byte-identical to the client
 * package's own AUTH_QUERY (client/src/types.ts) — a test asserts it.
 */
export const AUTH_QUERY = 'query Auth { auth { zcap { valid } } }'

/**
 * `type Zcap` + the `AuthQueries` namespace it hangs off — splice into
 * the resource server's SDL before `type Query`. Extra fields on
 * `checkAuthOnly`'s result (`reason`) are selectable too.
 */
export const AUTH_TYPEDEFS = /* GraphQL */ `
  """
  Presented ZCAP leaf, plus whether the resource server accepted the
  chain. Dev diagnostic only — Query.auth.zcap is not part of
  allowedAction and requires no invocation proof. \`allowedAction\` is
  the ZCAP field name (an array), not \`allowedActions\`.
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

  """
  Auth/diagnostic queries, namespaced under Query.auth — a sibling of
  Query.case (see the CASE module) rather than a flat root field, so a
  host server's own domain fields stay distinguishable from the ones
  this package splices in.
  """
  type AuthQueries {
    """
    Dev-only diagnostic — NOT part of the production allowedAction
    surface. Echoes the presented leaf and sets \`valid\` from
    checkAuthOnly. No invocation proof is required. Invalid chains
    still return this object with \`valid: false\` so
    \`query Auth { auth { zcap { valid } } }\` always resolves.
    """
    zcap: Zcap!
  }
`

/** Field to include on `type Query` so \`query Auth { auth { zcap { valid } } }\` resolves. */
export const AUTH_QUERY_FIELD = /* GraphQL */ `
    """Auth/diagnostic queries — see AuthQueries."""
    auth: AuthQueries!
`

export interface AuthResolverContext {
  zcapConfig: ZcapServerConfig
  payload: InvocationHeaderPayload | null
}

/**
 * `Query.auth.zcap` resolver. Attach next to the resource server's own
 * Query fields. Context must expose `zcapConfig` and `payload`.
 *
 * No gate on the namespace itself, unlike a host's own domain
 * namespaces: this diagnostic deliberately requires no invocation
 * proof, and an invalid chain must still resolve to `valid: false`
 * rather than error.
 */
export const authResolvers = {
  Query: {
    /** Namespace marker only — see AuthQueries for the real fields. */
    auth: () => ({}),
  },

  AuthQueries: {
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
