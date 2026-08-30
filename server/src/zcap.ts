// Real ZCAP-LD invocation checking for a GraphQL resource server.
// did:key + eddsa-jcs-2022 is verified entirely in-process (see
// localVerify.ts) — no other DID method is supported, and no agent
// or database call is ever made from this module. The caller (the
// consuming resource server, e.g. catalog-graphql) is responsible for
// resolving which root capability is trusted for a given request —
// by its own (controller, id, invocationTarget) lookup — and passes
// the result in as `rootCapability`.
//
// `unsafeMode` skips signature verification entirely (structural
// checks only) — dev/test only, so the full client<->server wire
// format can be exercised with no capability to actually verify
// against. Must default to false; see the warning `configureZcap`
// emits when it's on.

import { GraphQLError, parse } from 'graphql'
import type { DocumentNode, OperationDefinitionNode, SelectionSetNode } from 'graphql'
import type { Capability, SignedInvocation } from './localVerify.js'
import {
  verifyActionAllowed,
  verifyChain as verifyChainLocally,
  verifyInvocationProof,
} from './localVerify.js'
import type { ProblemDetail } from './problemDetails.js'

export interface InvocationHeaderPayload {
  chain: Capability[]
  invocation?: SignedInvocation
}

/** Used only by `unsafeMode` — structural checks against a fixed expectation, no signature ever inspected. */
export interface TrustConfig {
  trustedRootController: string
  expectedInvocationTarget?: string
}

export interface UnsafeZcapServerConfig {
  /** DEV/TEST ONLY. See module docstring. */
  unsafeMode: true
  trust: TrustConfig
}

export interface RealZcapServerConfig {
  unsafeMode?: false
  /**
   * The tenant's stored root capability for this request — resolved
   * by the caller's own DB lookup (controller, id, invocationTarget),
   * NEVER reconstructed by this library. Its `id` is what the
   * presented leaf's `parentCapability` is checked against.
   */
  rootCapability: Capability
  /** The target this request expects, derived from e.g. the Host header + a fixed path. */
  expectedInvocationTarget: string
}

export type ZcapServerConfig = UnsafeZcapServerConfig | RealZcapServerConfig

export function configureZcap(config: ZcapServerConfig): ZcapServerConfig {
  if (config.unsafeMode) {
    // eslint-disable-next-line no-console
    console.warn(
      '[did-graphql-server] UNSAFE_MODE is ON — capability chains are accepted with no ' +
        'signature ever verified. Never enable this in production.',
    )
  }
  return config
}

export function decodeInvocationHeader(headerValue: string | undefined): InvocationHeaderPayload | null {
  if (!headerValue) return null
  try {
    return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function normalizeQuery(text: string | undefined): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

// --- allowedAction as an attenuation mechanism, not just an exact-match whitelist ---
//
// allowedAction stays exactly what it always was — a flat array of
// real GraphQL query strings (never a structured/JSON scope object;
// the capabilityAction a real invocation signs has to be an actual
// query, matching what checkInvocation compares it to below). What
// changes is the comparison: a query is authorized if its own field
// selections (root field by root field, any depth, any combination)
// are a SUBSET of some already-registered entry's own selections —
// not only if it's byte-identical to one. Since every entry
// registered today already selects a type's full field set, those
// entries become upper bounds for free: trimming, reordering, or
// dropping fields from an already-allowed query just works, with no
// new entry to register. Argument VALUES aren't constrained by this
// at all — only which fields may be requested; see this module's
// README for that as a real, separate (and not yet built) axis.

/**
 * Every field name selected under a selection set, at any depth —
 * walks nested selections and inline fragments (`... on Type`, used
 * by polymorphic fields like catalog-graphql's `node`). __typename is
 * excluded: every GraphQL server allows it for free (it's metadata,
 * not something a capability needs to grant access to). Returns false
 * if the tree contains something this simple walk doesn't support
 * (a named fragment spread — no real query in this codebase uses
 * one) — callers should treat that as "can't confirm this is a
 * subset," not silently allow it.
 */
function collectFieldNames(selectionSet: SelectionSetNode | undefined, out: Set<string>): boolean {
  if (!selectionSet) return true
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      if (selection.name.value !== '__typename') out.add(selection.name.value)
      if (!collectFieldNames(selection.selectionSet, out)) return false
    } else if (selection.kind === 'InlineFragment') {
      if (!collectFieldNames(selection.selectionSet, out)) return false
    } else {
      return false // FragmentSpread — unsupported, see doc comment above
    }
  }
  return true
}

/**
 * Parses `query` into root-field-name -> the flattened set of every
 * field selected anywhere under it. Returns null if the query can't
 * be parsed, has no operation, or hits something collectFieldNames
 * doesn't support — never partial results, so a caller can't
 * accidentally authorize against an incomplete picture.
 */
function fieldsByRootField(query: string): Map<string, Set<string>> | null {
  let doc: DocumentNode
  try {
    doc = parse(query)
  } catch {
    return null
  }
  const op = doc.definitions.find((d): d is OperationDefinitionNode => d.kind === 'OperationDefinition')
  if (!op) return null

  const map = new Map<string, Set<string>>()
  for (const selection of op.selectionSet.selections) {
    if (selection.kind !== 'Field') return null
    const fields = new Set<string>()
    if (!collectFieldNames(selection.selectionSet, fields)) return null
    // A document could alias the same root field twice — union rather
    // than overwrite so both selections' fields both count.
    const existing = map.get(selection.name.value)
    map.set(selection.name.value, existing ? new Set([...existing, ...fields]) : fields)
  }
  return map
}

/**
 * True if every root field `queryFields` asks about is also present
 * in `entry` (same real field name — aliases don't count), and every
 * field requested under it is within what `entry` itself requests
 * under that same root field. `entry` failing to parse (e.g. it's not
 * actually a GraphQL document) just means it doesn't match — not an
 * error, since allowedAction can hold ordinary exact-match strings
 * that happen not to parse as a full query on their own only in
 * degenerate/malformed cases, which should fail closed either way.
 */
function isFieldSubsetOfEntry(queryFields: Map<string, Set<string>>, entry: string): boolean {
  const entryFields = fieldsByRootField(entry)
  if (!entryFields) return false
  for (const [rootField, fields] of queryFields) {
    const allowed = entryFields.get(rootField)
    if (!allowed) return false
    for (const field of fields) {
      if (!allowed.has(field)) return false
    }
  }
  return true
}

/**
 * The actual allowedAction membership check — exact string match
 * first (cheap, and the common case for a query sent verbatim as
 * registered), falling back to the field-subset check above for
 * anything that isn't byte-identical but might still be a legitimate
 * narrower selection of an already-allowed query.
 */
function matchesAllowedAction(allowedAction: string[] | undefined, rawQueryText: string): boolean {
  const normalized = normalizeQuery(rawQueryText)
  if ((allowedAction ?? []).some((entry) => normalizeQuery(entry) === normalized)) return true

  const queryFields = fieldsByRootField(rawQueryText)
  if (!queryFields) return false
  return (allowedAction ?? []).some((entry) => isFieldSubsetOfEntry(queryFields, entry))
}

// --- unsafeMode structural fallback (ported from catalog-graphql-mock's zcap.js) ---

const REQUIRED_FIELDS = ['id', 'controller', 'invocationTarget', 'allowedAction', 'proof'] as const

function structuralProblems(cap: Capability | undefined): string[] {
  if (!cap || typeof cap !== 'object') return ['missing capability']
  const problems: string[] = []
  for (const field of REQUIRED_FIELDS) {
    if ((cap as Record<string, unknown>)[field] === undefined || (cap as Record<string, unknown>)[field] === null) {
      problems.push(`missing ${field}`)
    }
  }
  if (cap.allowedAction && !Array.isArray(cap.allowedAction)) problems.push('allowedAction must be an array')
  if (cap.proof && typeof cap.proof !== 'object') problems.push('proof must be an object')
  if (cap.proof && !(cap.proof as Record<string, unknown>)['verificationMethod']) {
    problems.push('proof missing verificationMethod')
  }
  return problems
}

function expiryProblem(cap: Capability, now: Date): string | null {
  if (!cap.expires) return 'missing expires'
  const deadline = new Date(cap.expires)
  if (Number.isNaN(deadline.getTime())) return `expires not parseable: ${cap.expires}`
  if (now > deadline) return `expired at ${cap.expires}`
  return null
}

function presentZcap(
  leaf: Capability | undefined,
  valid: boolean,
  reason: string | null,
  problems?: ProblemDetail[],
): PresentedZcap {
  return {
    valid,
    reason,
    problems: problems ?? [],
    id: leaf?.id ?? null,
    controller: leaf?.controller ?? null,
    invocationTarget: leaf?.invocationTarget ?? null,
    allowedAction: leaf?.allowedAction ?? null,
    expires: leaf?.expires ?? null,
  }
}

/**
 * GraphQL `Zcap` payload for `query Auth { zcap { valid } }`.
 * Leaf fields are echoed even when `valid` is false. `problems` is the
 * structured (typeURI-tagged) form of `reason` — empty when `valid`,
 * or under `unsafeMode` (which never produces ProblemDetails).
 */
export interface PresentedZcap {
  valid: boolean
  reason: string | null
  problems: ProblemDetail[]
  id: string | null
  controller: string | null
  invocationTarget: string | null
  allowedAction: string[] | null
  expires: string | null
}

function structuralCheckAuthOnly(payload: InvocationHeaderPayload | null, trust: TrustConfig): PresentedZcap {
  const leaf = payload?.chain?.[0]
  const problems = structuralProblems(leaf)
  if (problems.length) return presentZcap(leaf, false, problems.join('; '))

  const expiryIssue = expiryProblem(leaf!, new Date())
  if (expiryIssue) return presentZcap(leaf, false, expiryIssue)

  if (trust.expectedInvocationTarget && leaf!.invocationTarget !== trust.expectedInvocationTarget) {
    return presentZcap(leaf, false, `invocationTarget mismatch: ${leaf!.invocationTarget}`)
  }
  return presentZcap(leaf, true, null)
}

// --- real checks: local did:key verification only ---

/** Used by `Query.zcap` (`query Auth { zcap { valid } }`) — chain validity only, no invocation required. */
export function checkAuthOnly(config: ZcapServerConfig, payload: InvocationHeaderPayload | null): PresentedZcap {
  if (config.unsafeMode) return structuralCheckAuthOnly(payload, config.trust)

  const leaf = payload?.chain?.[0]
  if (!leaf) return presentZcap(undefined, false, 'missing capability')

  const result = verifyChainLocally(leaf, config.rootCapability, config.expectedInvocationTarget)
  if (!result.verified) {
    return presentZcap(leaf, false, result.errors.map((e) => e.detail).join('; '), result.errors)
  }
  return presentZcap(leaf, true, null)
}

export interface InvocationCheckResult {
  ok: boolean
  code?: 'CAPABILITY_INVALID' | 'QUERY_NOT_ALLOWED' | 'INVOCATION_INVALID'
  message?: string
  problems?: ProblemDetail[]
}

/** Used by real data-fetching resolvers — full gate: chain validity + allowedAction match + a real invocation proof (unless unsafeMode). */
export function checkInvocation(
  config: ZcapServerConfig,
  payload: InvocationHeaderPayload | null,
  rawQueryText: string,
): InvocationCheckResult {
  const leaf = payload?.chain?.[0]
  if (!leaf) return { ok: false, code: 'CAPABILITY_INVALID', message: 'missing capability' }

  if (config.unsafeMode) {
    const base = structuralCheckAuthOnly(payload, config.trust)
    if (!base.valid) return { ok: false, code: 'CAPABILITY_INVALID', message: base.reason ?? undefined }
    if (!matchesAllowedAction(leaf.allowedAction, rawQueryText)) {
      return { ok: false, code: 'QUERY_NOT_ALLOWED', message: 'requested operation is not in allowedAction' }
    }
    return { ok: true }
  }

  const chainResult = verifyChainLocally(leaf, config.rootCapability, config.expectedInvocationTarget)
  if (!chainResult.verified) {
    return {
      ok: false,
      code: 'CAPABILITY_INVALID',
      message: chainResult.errors.map((e) => e.detail).join('; '),
      problems: chainResult.errors,
    }
  }

  const actionResult = verifyActionAllowed(leaf, rawQueryText, matchesAllowedAction)
  if (!actionResult.verified) {
    return {
      ok: false,
      code: 'QUERY_NOT_ALLOWED',
      message: actionResult.errors.map((e) => e.detail).join('; '),
      problems: actionResult.errors,
    }
  }

  const invocationResult = verifyInvocationProof(leaf, payload?.invocation, rawQueryText)
  if (!invocationResult.verified) {
    return {
      ok: false,
      code: 'INVOCATION_INVALID',
      message: invocationResult.errors.map((e) => e.detail).join('; '),
      problems: invocationResult.errors,
    }
  }
  return { ok: true }
}

/** Throw a GraphQL error when `checkInvocation` rejects. Used by CASE (and catalog) Query fields. */
export async function requireAuthorizedQuery(
  config: ZcapServerConfig,
  payload: InvocationHeaderPayload | null,
  rawQueryText: string,
  fieldName: string,
): Promise<void> {
  const result = checkInvocation(config, payload, rawQueryText)
  if (!result.ok) {
    throw new GraphQLError(result.message ?? 'unauthorized', {
      extensions: { code: result.code, problems: result.problems },
      path: [fieldName],
    })
  }
}
