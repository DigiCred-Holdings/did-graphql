// Real ZCAP-LD invocation checking for a GraphQL resource server.
// Every check resolves to an actual verification call against the
// tenant's own agent (see agentClient.ts) — UNLESS `unsafeMode` is on,
// in which case it falls back to structural-only checks (no agent
// call, no signature ever inspected). unsafeMode exists purely so the
// full client→server wire format can be exercised in dev/test without
// a live agent to verify against; it must default to false and any
// deployment enabling it should treat that as a loud, deliberate
// choice, never an accident (see the warning `configureZcap` emits).

import { GraphQLError, parse } from 'graphql'
import type { DocumentNode, OperationDefinitionNode, SelectionSetNode } from 'graphql'
import type { AgentConfig, Capability } from './agentClient.js'
import { mintRootCapability, verifyChain, verifyInvocation } from './agentClient.js'

export interface InvocationHeaderPayload {
  chain: Capability[]
  invocation?: Record<string, unknown>
}

export interface TrustConfig {
  trustedRootController: string
  expectedInvocationTarget?: string
}

export interface ZcapServerConfig {
  trust: TrustConfig
  /** Required unless unsafeMode is true. */
  agentConfig?: AgentConfig
  /** DEV/TEST ONLY — default false. See module docstring. */
  unsafeMode?: boolean
}

export function configureZcap(config: ZcapServerConfig): ZcapServerConfig {
  if (config.unsafeMode) {
    // eslint-disable-next-line no-console
    console.warn(
      '[did-graphql-server] UNSAFE_MODE is ON — capability chains are accepted with no ' +
        'invocation signature and no agent verification call. Never enable this in production.',
    )
  } else if (!config.agentConfig) {
    throw new Error('ZcapServerConfig.agentConfig is required unless unsafeMode is true')
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

function summarizeProblems(problems: { title?: string; type?: string }[] | undefined): string {
  return (problems ?? []).map((p) => p.title ?? p.type ?? 'unknown problem').join('; ') || 'verification failed'
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

function presentZcap(leaf: Capability | undefined, valid: boolean, reason: string | null): PresentedZcap {
  return {
    valid,
    reason,
    id: leaf?.id ?? null,
    controller: leaf?.controller ?? null,
    invocationTarget: leaf?.invocationTarget ?? null,
    allowedAction: leaf?.allowedAction ?? null,
    expires: leaf?.expires ?? null,
  }
}

/**
 * GraphQL `Zcap` payload for `query Auth { zcap { valid } }`.
 * Leaf fields are echoed even when `valid` is false.
 */
export interface PresentedZcap {
  valid: boolean
  reason: string | null
  id: string | null
  controller: string | null
  invocationTarget: string | null
  allowedAction: string[] | null
  expires: string | null
}

function structuralCheckAuthOnly(
  payload: InvocationHeaderPayload | null,
  trust: TrustConfig,
): PresentedZcap {
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

// --- real, agent-backed checks ---

/**
 * The wallet only ever sends the delegated leaf capability — the root
 * it descends from is never transmitted (it's unsigned, trusted by
 * local dereference per spec). Reconstruct it here so the agent's
 * verify endpoints see a complete leaf→root chain.
 */
async function reconstructFullChain(
  agentConfig: AgentConfig,
  leaf: Capability,
  trust: TrustConfig,
): Promise<Capability[]> {
  const root = await mintRootCapability(agentConfig, {
    invocationTarget: leaf.invocationTarget,
    controller: trust.trustedRootController,
  })
  return [leaf, root]
}

/** Used by `Query.zcap` (`query Auth { zcap { valid } }`) — chain validity only, no invocation required. */
export async function checkAuthOnly(
  config: ZcapServerConfig,
  payload: InvocationHeaderPayload | null,
): Promise<PresentedZcap> {
  if (config.unsafeMode) return structuralCheckAuthOnly(payload, config.trust)

  const leaf = payload?.chain?.[0]
  if (!leaf) return presentZcap(undefined, false, 'missing capability')

  const chain = await reconstructFullChain(config.agentConfig!, leaf, config.trust)
  const result = await verifyChain(config.agentConfig!, {
    chain,
    trustedRootController: config.trust.trustedRootController,
    expectedInvocationTarget: config.trust.expectedInvocationTarget,
  })
  if (!result.verified) return presentZcap(leaf, false, summarizeProblems(result.errors))
  return presentZcap(leaf, true, null)
}

export interface InvocationCheckResult {
  ok: boolean
  code?: 'CAPABILITY_INVALID' | 'QUERY_NOT_ALLOWED' | 'INVOCATION_INVALID'
  message?: string
}

/** Used by real data-fetching resolvers — full gate: chain validity + allowedAction match + (unless unsafeMode) real invocation verification. */
export async function checkInvocation(
  config: ZcapServerConfig,
  payload: InvocationHeaderPayload | null,
  rawQueryText: string,
): Promise<InvocationCheckResult> {
  const leaf = payload?.chain?.[0]
  if (!leaf) return { ok: false, code: 'CAPABILITY_INVALID', message: 'missing capability' }

  if (config.unsafeMode) {
    const base = structuralCheckAuthOnly(payload, config.trust)
    if (!base.valid) return { ok: false, code: 'CAPABILITY_INVALID', message: base.reason ?? undefined }
  } else {
    const base = await checkAuthOnly(config, payload)
    if (!base.valid) return { ok: false, code: 'CAPABILITY_INVALID', message: base.reason ?? undefined }
  }

  if (!matchesAllowedAction(leaf.allowedAction, rawQueryText)) {
    return { ok: false, code: 'QUERY_NOT_ALLOWED', message: 'requested operation is not in allowedAction' }
  }

  if (config.unsafeMode) return { ok: true }

  if (!payload?.invocation) {
    return { ok: false, code: 'INVOCATION_INVALID', message: 'missing invocation' }
  }

  const chain = await reconstructFullChain(config.agentConfig!, leaf, config.trust)
  const result = await verifyInvocation(config.agentConfig!, {
    invocation: payload.invocation,
    chain,
    trustedRootController: config.trust.trustedRootController,
    expectedInvocationTarget: config.trust.expectedInvocationTarget,
  })
  if (!result.verified) {
    return { ok: false, code: 'INVOCATION_INVALID', message: summarizeProblems(result.errors) }
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
  const result = await checkInvocation(config, payload, rawQueryText)
  if (!result.ok) {
    throw new GraphQLError(result.message ?? 'unauthorized', {
      extensions: { code: result.code },
      path: [fieldName],
    })
  }
}
