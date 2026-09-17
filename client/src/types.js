/**
 * Dev diagnostic document (`DidGraphQLClient.checkAuth`). Not a
 * production `allowedAction`. Extra `Zcap` fields (controller,
 * invocationTarget, allowedAction, …) are optional selections on the
 * same type. Must stay byte-identical to the server package's own
 * AUTH_QUERY (server/src/auth.ts) — a test asserts it.
 */
export const AUTH_QUERY = 'query Auth { auth { zcap { valid } } }';
