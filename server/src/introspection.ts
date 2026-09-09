// Schema introspection is not covered by `checkInvocation`.
//
// The `allowedAction` gate runs inside field resolvers, and `__schema`
// / `__type` are graphql-js built-in meta-fields with no resolver of
// ours — so a document selecting only those never touches a gated code
// path and answers straight from the schema, with no capability
// present at all. That leaks the whole API shape (every type, field,
// and argument name) to an unauthenticated caller. No data leaks, but
// it is free reconnaissance, and for a schema with an administrative
// surface it names those fields and their input types too.
//
// A host closes it by calling `checkIntrospection` once per request,
// before `graphql()` — see the README's "Introspection" section.

import { Kind, parse, type DocumentNode, type FragmentDefinitionNode, type SelectionSetNode } from 'graphql'
import { checkAuthOnly, type InvocationHeaderPayload, type ZcapServerConfig } from './zcap.js'

/**
 * `__typename` is deliberately NOT here: it discloses only the type of
 * something the caller already selected, the same reason
 * `matchesAllowedAction` ignores it.
 */
const INTROSPECTION_FIELDS = new Set(['__schema', '__type'])

function selectsIntrospection(
  selectionSet: SelectionSetNode | undefined,
  fragments: Map<string, FragmentDefinitionNode>,
  seen: Set<string>,
): boolean {
  if (!selectionSet) return false
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      // Aliases don't matter — `{ s: __schema { ... } }` is still introspection.
      if (INTROSPECTION_FIELDS.has(selection.name.value)) return true
      if (selectsIntrospection(selection.selectionSet, fragments, seen)) return true
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      if (selectsIntrospection(selection.selectionSet, fragments, seen)) return true
    } else {
      // A named fragment can hide __schema several hops away from the
      // operation — follow it. `seen` guards the cyclic-fragment case
      // (graphql-js rejects those at validation, but this runs first).
      const name = selection.name.value
      if (seen.has(name)) continue
      seen.add(name)
      const fragment = fragments.get(name)
      if (fragment && selectsIntrospection(fragment.selectionSet, fragments, seen)) return true
    }
  }
  return false
}

/**
 * True if `query` selects `__schema` or `__type` anywhere — at the
 * root, nested, aliased, or reached through inline and named
 * fragments.
 *
 * An unparseable document returns false: `graphql()` is about to fail
 * it with a syntax error anyway, and both sides parse with the same
 * graphql-js, so there is no document this sees differently from the
 * executor. A non-string returns false for the same reason — it is not
 * a document, and whatever the caller does with it next will reject it.
 */
export function containsSchemaIntrospection(query: unknown): boolean {
  // A caller's `query` comes from a JSON body, where it can be absent
  // or any type at all — and the substring precheck below would throw a
  // TypeError on a non-string, which in an async request handler is an
  // unhandled rejection that ends the process. A non-string is not a
  // document and cannot select anything, so say so and let the caller's
  // own validation (or graphql()) reject it.
  if (typeof query !== 'string') return false

  // A field name can't be built dynamically in a GraphQL document, so a
  // document whose text contains neither name cannot select either
  // field, and the parse is pure cost — worth skipping, since a host
  // following the README calls this on every request and graphql-js
  // parses again during execution. Only ever a false positive: any
  // document with `__typename` contains `__type` and still gets parsed,
  // as does one merely mentioning `"__schema"` in a string argument.
  if (!query.includes('__schema') && !query.includes('__type')) return false

  let doc: DocumentNode
  try {
    doc = parse(query)
  } catch {
    return false
  }
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const definition of doc.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition)
  }
  for (const definition of doc.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue
    if (selectsIntrospection(definition.selectionSet, fragments, new Set())) return true
  }
  return false
}

/**
 * What a request must present to read the schema:
 *
 * - `authorized` (default) — a structurally valid, unexpired capability
 *   chain for this invocationTarget, i.e. what `checkAuthOnly` reports.
 *   Deliberately NOT `allowedAction` membership: no real capability
 *   lists GraphiQL's introspection document, and knowing the shape of
 *   an API you already hold a capability for discloses strictly less
 *   than the data behind it.
 * - `public` — anyone may introspect. The pre-`checkIntrospection`
 *   behavior; fine for an intentionally public schema.
 * - `off` — nobody may introspect, capability or not.
 */
export type IntrospectionPolicy = 'authorized' | 'public' | 'off'

export interface IntrospectionCheckResult {
  ok: boolean
  code?: 'INTROSPECTION_NOT_ALLOWED'
  message?: string
}

/**
 * Call once per request, before `graphql()`, and reject the request
 * when `ok` is false. A document that doesn't introspect always
 * passes, so this is safe to call unconditionally — the per-field
 * `checkInvocation` gate still does all the real authorization work.
 *
 * In `unsafeMode` an `authorized` policy accepts the same structural
 * check everything else does there, which keeps a dev GraphiQL page
 * working without a real capability.
 */
export function checkIntrospection(
  config: ZcapServerConfig,
  payload: InvocationHeaderPayload | null,
  rawQueryText: unknown,
  policy: IntrospectionPolicy = 'authorized',
): IntrospectionCheckResult {
  if (policy === 'public') return { ok: true }
  if (!containsSchemaIntrospection(rawQueryText)) return { ok: true }

  if (policy === 'off') {
    return {
      ok: false,
      code: 'INTROSPECTION_NOT_ALLOWED',
      message: 'schema introspection is disabled on this server',
    }
  }

  const auth = checkAuthOnly(config, payload)
  if (!auth.valid) {
    return {
      ok: false,
      code: 'INTROSPECTION_NOT_ALLOWED',
      message: `schema introspection requires a valid capability for this endpoint: ${auth.reason ?? 'no valid capability presented'}`,
    }
  }
  return { ok: true }
}
