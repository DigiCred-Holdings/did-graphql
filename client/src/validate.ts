import type { Capability } from './types.js'
import { CapabilityExpiredError, InvalidCapabilityError } from './errors.js'
import { isExpired } from './zcap.js'

const REQUIRED_FIELDS = ['id', 'controller', 'invocationTarget', 'allowedAction', 'proof'] as const
const DID_RE = /^did:[a-z0-9]+:[^\s]+$/i

export interface GraphqlZcapValidationOptions {
  /**
   * Allow `http:` and loopback/private hosts. Defaults to false.
   * Only for local catalog-graphql against a host you already trust.
   */
  allowInsecureEndpoint?: boolean
  /**
   * Independent pin (workflow template `catalog.zcap.graphql.invocationTarget`,
   * tenant allowlist entry, DID service endpoint). If set, the capability
   * `invocationTarget` MUST canonicalize to the same URL.
   */
  expectedInvocationTarget?: string
  /**
   * URL the caller intends to POST to. If set, it MUST canonicalize to the
   * same URL as `invocationTarget` — this client MUST NOT send a ZCAP to a
   * different host than the capability authorizes.
   */
  fetchEndpoint?: string
  /**
   * Hostname allowlist. An entry is an exact host or a suffix pattern
   * (`*.digicred.services` matches that domain and any subdomain).
   * If set and non-empty, the invocationTarget host MUST match one entry.
   */
  allowedHosts?: string[]
  /** Clock for expiry. Defaults to now. */
  now?: Date
  /** If false, `expires` MUST still be present and parseable, but a past deadline is allowed. Defaults to true. */
  checkExpiry?: boolean
}

export interface ValidatedGraphqlZcap {
  capability: Capability
  /** Canonical GraphQL URL — POST here and here only. */
  invocationTarget: string
}

/**
 * GraphQL ZCAP validation algorithm (client-side, non-cryptographic).
 *
 * This does **not** verify Data Integrity proofs. The resource server MUST
 * still verify the chain and invocation. These steps decide whether a
 * wallet is willing to put this capability in `x-zcap-invocation` and POST
 * it — the capability is otherwise a bearer token to whoever receives it.
 *
 * Inputs: `capability`, optional `expectedInvocationTarget` / `fetchEndpoint`
 * / `allowedHosts` / `allowInsecureEndpoint`.
 *
 * 1. The capability MUST be an object. It MUST contain `id`, `controller`,
 *    `invocationTarget`, `allowedAction`, and `proof`.
 * 2. `proof` MUST be an object and MUST contain `verificationMethod`.
 * 3. `controller` MUST be a DID (`did:` + method + method-specific id).
 * 4. `invocationTarget` MUST be an absolute GraphQL HTTP URL:
 *    - parseable as a URL
 *    - no `userinfo` (credentials in the URL)
 *    - no fragment
 *    - pathname `/graphql` or ending in `/graphql` (trailing slash ignored)
 * 5. That URL's protocol MUST be `https:` unless `allowInsecureEndpoint`.
 * 6. Its hostname MUST NOT be loopback, link-local, or RFC1918 (or `.local` /
 *    `.localhost` / `.internal`) unless `allowInsecureEndpoint`.
 * 7. If `allowedHosts` is non-empty, the hostname MUST match an entry.
 * 8. If `expectedInvocationTarget` is set, it MUST canonicalize to the same
 *    URL as `invocationTarget` (template/DID pin).
 * 9. If `fetchEndpoint` is set, it MUST canonicalize to the same URL. The
 *    client MUST POST only to `invocationTarget`.
 * 10. `allowedAction` MUST be a non-empty array of GraphQL `query` or
 *     `mutation` documents (not `subscription`).
 * 11. `expires` MUST be present and parseable. It MUST NOT be in the past.
 *
 * On success, returns the capability and the canonical invocationTarget
 * (the only URL the caller may fetch). On failure, throws
 * `InvalidCapabilityError` or `CapabilityExpiredError`.
 */
export function validateGraphqlZcap(
  capability: Capability,
  options: GraphqlZcapValidationOptions = {},
): ValidatedGraphqlZcap {
  const problems = collectGraphqlZcapProblems(capability, options)
  const expired = problems.includes('expired')
  const rest = problems.filter((p) => p !== 'expired')
  if (rest.length) throw new InvalidCapabilityError(rest)
  if (expired) throw new CapabilityExpiredError(capability)
  return {
    capability,
    invocationTarget: canonicalizeGraphqlUrl(new URL(capability.invocationTarget)),
  }
}

/** True/false wrapper for UI state. */
export function isValidGraphqlZcap(
  capability: Capability,
  options: GraphqlZcapValidationOptions = {},
): boolean {
  try {
    validateGraphqlZcap(capability, options)
    return true
  } catch {
    return false
  }
}

/**
 * Structural-only subset (steps 1–2). Prefer `validateGraphqlZcap` before
 * sending. Kept for callers that only need a deserialize sanity check.
 */
export function validateCapabilityShape(capability: Capability): void {
  const problems = structuralProblems(capability)
  if (problems.length) throw new InvalidCapabilityError(problems)
}

export function isValidCapabilityShape(capability: Capability): boolean {
  return structuralProblems(capability).length === 0
}

export function collectGraphqlZcapProblems(
  capability: Capability,
  options: GraphqlZcapValidationOptions = {},
): string[] {
  const problems = structuralProblems(capability)
  if (problems.length && problems[0] === 'missing capability') return problems

  if (capability.controller !== undefined && capability.controller !== null) {
    if (typeof capability.controller !== 'string' || !DID_RE.test(capability.controller)) {
      problems.push('controller MUST be a DID')
    }
  }

  const targetProblems = graphqlEndpointProblems(capability.invocationTarget, options, 'invocationTarget')
  problems.push(...targetProblems)

  if (options.expectedInvocationTarget) {
    if (!sameGraphqlEndpoint(capability.invocationTarget, options.expectedInvocationTarget)) {
      problems.push(
        'invocationTarget MUST equal expectedInvocationTarget (the GraphQL endpoint this ZCAP is for)',
      )
    }
  }

  if (options.fetchEndpoint) {
    if (!sameGraphqlEndpoint(capability.invocationTarget, options.fetchEndpoint)) {
      problems.push(
        'fetch endpoint MUST equal invocationTarget — refusing to send a ZCAP to a different URL than the capability authorizes',
      )
    }
  }

  problems.push(...allowedActionProblems(capability.allowedAction))
  problems.push(...expiryProblems(capability, options))

  return problems
}

function structuralProblems(capability: Capability): string[] {
  if (!capability || typeof capability !== 'object') return ['missing capability']
  const problems: string[] = []
  for (const field of REQUIRED_FIELDS) {
    if (capability[field] === undefined || capability[field] === null) problems.push(`missing ${field}`)
  }
  if (capability.allowedAction && !Array.isArray(capability.allowedAction)) {
    problems.push('allowedAction MUST be an array')
  }
  if (capability.proof && typeof capability.proof !== 'object') {
    problems.push('proof MUST be an object')
  }
  if (capability.proof && !capability.proof.verificationMethod) {
    problems.push('proof missing verificationMethod')
  }
  return problems
}

function graphqlEndpointProblems(
  value: string | undefined,
  options: GraphqlZcapValidationOptions,
  label: string,
): string[] {
  if (value === undefined || value === null || value === '') return []
  if (typeof value !== 'string') return [`${label} MUST be a string URL`]

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return [`${label} MUST be an absolute URL`]
  }

  const problems: string[] = []
  if (url.username || url.password) problems.push(`${label} MUST NOT contain userinfo`)
  if (url.hash) problems.push(`${label} MUST NOT contain a fragment`)

  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (path !== '/graphql' && !path.endsWith('/graphql')) {
    problems.push(`${label} MUST be a GraphQL HTTP endpoint (pathname /graphql)`)
  }

  const allowInsecure = options.allowInsecureEndpoint ?? false
  if (url.protocol !== 'https:') {
    if (!(allowInsecure && url.protocol === 'http:')) {
      problems.push(`${label} MUST use https`)
    }
  }

  const host = url.hostname.toLowerCase()
  if (isPrivateOrLocalHostname(host) && !allowInsecure) {
    problems.push(`${label} MUST NOT be a loopback, link-local, or private address`)
  }

  if (options.allowedHosts?.length && !hostMatchesAllowlist(host, options.allowedHosts)) {
    problems.push(`${label} host MUST match allowedHosts`)
  }

  return problems
}

function allowedActionProblems(allowedAction: string[] | undefined): string[] {
  if (allowedAction === undefined || allowedAction === null) return []
  if (!Array.isArray(allowedAction)) return []
  if (allowedAction.length === 0) return ['allowedAction MUST contain at least one GraphQL document']
  const problems: string[] = []
  allowedAction.forEach((entry, i) => {
    if (typeof entry !== 'string' || !looksLikeGraphqlDocument(entry)) {
      problems.push(`allowedAction[${i}] MUST be a GraphQL query or mutation document`)
    }
  })
  return problems
}

function expiryProblems(capability: Capability, options: GraphqlZcapValidationOptions): string[] {
  if (!capability.expires) return ['expires MUST be present']
  const deadline = new Date(capability.expires)
  if (Number.isNaN(deadline.getTime())) return [`expires MUST be a parseable date (${capability.expires})`]
  if (options.checkExpiry !== false && isExpired(capability, options.now ?? new Date())) return ['expired']
  return []
}

function looksLikeGraphqlDocument(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/^subscription\b/i.test(t)) return false
  if (/^(query|mutation)\b/i.test(t)) return t.includes('{')
  return t.startsWith('{')
}

function canonicalizeGraphqlUrl(url: URL): string {
  const path = (url.pathname.replace(/\/+$/, '') || '') + (url.search || '')
  const host = url.hostname.toLowerCase()
  const dropPort =
    !url.port ||
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  return `${url.protocol}//${host}${dropPort ? '' : `:${url.port}`}${path}`
}

function sameGraphqlEndpoint(a: string, b: string): boolean {
  try {
    return canonicalizeGraphqlUrl(new URL(a)) === canonicalizeGraphqlUrl(new URL(b))
  } catch {
    return false
  }
}

function hostMatchesAllowlist(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase()
  return allowedHosts.some((entry) => {
    const pattern = entry.trim().toLowerCase()
    if (!pattern) return false
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // .example.com
      return host === pattern.slice(2) || host.endsWith(suffix)
    }
    return host === pattern
  })
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal')) return true

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (ipv4) {
    const oct = ipv4.slice(1).map(Number)
    if (oct.some((n) => n > 255)) return true
    const [a, b] = oct
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }

  if (h === '::1' || h === '::') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  return false
}
