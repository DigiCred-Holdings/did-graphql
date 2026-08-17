// Real ZCAP-LD invocation checking for a GraphQL resource server.
// Every check resolves to an actual verification call against the
// tenant's own agent (see agentClient.ts) — UNLESS `unsafeMode` is on,
// in which case it falls back to structural-only checks (no agent
// call, no signature ever inspected). unsafeMode exists purely so the
// full client→server wire format can be exercised in dev/test without
// a live agent to verify against; it must default to false and any
// deployment enabling it should treat that as a loud, deliberate
// choice, never an accident (see the warning `configureZcap` emits).

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

function structuralCheckAuthOnly(
  payload: InvocationHeaderPayload | null,
  trust: TrustConfig,
): { valid: boolean; reason: string | null } {
  const leaf = payload?.chain?.[0]
  const problems = structuralProblems(leaf)
  if (problems.length) return { valid: false, reason: problems.join('; ') }

  const expiryIssue = expiryProblem(leaf!, new Date())
  if (expiryIssue) return { valid: false, reason: expiryIssue }

  if (trust.expectedInvocationTarget && leaf!.invocationTarget !== trust.expectedInvocationTarget) {
    return { valid: false, reason: `invocationTarget mismatch: ${leaf!.invocationTarget}` }
  }
  return { valid: true, reason: null }
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

/** Used by a `zcap` diagnostic query — chain validity only, no invocation required. */
export async function checkAuthOnly(
  config: ZcapServerConfig,
  payload: InvocationHeaderPayload | null,
): Promise<{ valid: boolean; reason: string | null }> {
  if (config.unsafeMode) return structuralCheckAuthOnly(payload, config.trust)

  const leaf = payload?.chain?.[0]
  if (!leaf) return { valid: false, reason: 'missing capability' }

  const chain = await reconstructFullChain(config.agentConfig!, leaf, config.trust)
  const result = await verifyChain(config.agentConfig!, {
    chain,
    trustedRootController: config.trust.trustedRootController,
    expectedInvocationTarget: config.trust.expectedInvocationTarget,
  })
  if (!result.verified) return { valid: false, reason: summarizeProblems(result.errors) }
  return { valid: true, reason: null }
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

  const normalized = normalizeQuery(rawQueryText)
  const allowed = (leaf.allowedAction ?? []).some((entry) => normalizeQuery(entry) === normalized)
  if (!allowed) {
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
