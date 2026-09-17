// Verifies an RFC 9421 HTTP Message Signature over an invocation — the
// ZCAP spec's own proof mechanism (Example 9).
//
// The signature base builder is duplicated from the client package —
// see the note below for why, and for what keeps the two in step.

import { createPublicKey, createHash, verify as cryptoVerify } from 'node:crypto'

import { didFromVerificationMethod, ed25519PublicKeyFromDidKey, isDidKey } from './didKey.js'
import type { Capability } from './localVerify.js'

// Deliberately a parallel implementation of the client's builder rather
// than an import: these are two independently published packages, and a
// resource server must not depend on the client. The repo already
// handles `eddsaJcs2022` the same way, with a test pinning the two
// against each other — `test/http-signature.test.ts` does that here, so
// a drift between them fails at build time rather than as an opaque
// "signature invalid" in production.

/** Covered components, in order — matches the spec's Example 9. */
const COVERED_COMPONENTS = [
  '@method',
  '@path',
  'capability-invocation',
  'content-digest',
  'content-type',
] as const

function signatureParams(keyid: string, created: number): string {
  const components = COVERED_COMPONENTS.map((c) => `"${c}"`).join(' ')
  return `(${components});alg="ed25519";created=${created};keyid="${keyid}"`
}

/**
 * One line per covered component as `"name": value`, newline-separated,
 * ending with `"@signature-params": <params>` and no trailing newline.
 */
export function buildSignatureBase(input: {
  method: string
  path: string
  capabilityInvocation: string
  contentDigest: string
  contentType: string
  keyid: string
  created: number
}): string {
  const values: Record<(typeof COVERED_COMPONENTS)[number], string> = {
    '@method': input.method.toUpperCase(),
    '@path': input.path,
    'capability-invocation': input.capabilityInvocation,
    'content-digest': input.contentDigest,
    'content-type': input.contentType,
  }
  const lines = COVERED_COMPONENTS.map((c) => `"${c}": ${values[c]}`)
  lines.push(`"@signature-params": ${signatureParams(input.keyid, input.created)}`)
  return lines.join('\n')
}

/** `@path` — the path only, no query string. */
export function pathOf(endpoint: string): string {
  try {
    return new URL(endpoint).pathname
  } catch {
    return endpoint
  }
}

export interface HttpSignatureRequest {
  method: string
  /** Full URL or path. Only the path is covered, per RFC 9421's `@path`. */
  url: string
  /** The exact `Capability-Invocation` header value that was received. */
  capabilityInvocation: string
  contentType: string
  contentDigest?: string
  signatureInput?: string
  signature?: string
  /** Raw request body, for the Content-Digest check. */
  body: string
}

export interface HttpSignatureResult {
  verified: boolean
  reason?: string
  /** Seconds since epoch from `created`, for the caller's freshness check. */
  created?: number
  keyid?: string
}

function fail(reason: string): HttpSignatureResult {
  return { verified: false, reason }
}

/** Pull `label=(components);alg="…";created=…;keyid="…"` apart. */
function parseSignatureInput(value: string): { label: string; params: string; created?: number; keyid?: string; alg?: string } | null {
  const match = /^([A-Za-z0-9_-]+)=(\(.*)$/.exec(value.trim())
  if (!match) return null
  const [, label, params] = match
  const created = /;created=(\d+)/.exec(params!)?.[1]
  return {
    label: label!,
    params: params!,
    created: created ? Number(created) : undefined,
    keyid: /;keyid="([^"]*)"/.exec(params!)?.[1],
    alg: /;alg="([^"]*)"/.exec(params!)?.[1],
  }
}

/** `label=:<base64>:` */
function parseSignature(value: string, label: string): Uint8Array | null {
  const match = new RegExp(`(?:^|,)\\s*${label}=:([A-Za-z0-9+/=]+):`).exec(value)
  if (!match) return null
  try {
    return new Uint8Array(Buffer.from(match[1]!, 'base64'))
  } catch {
    return null
  }
}

function digestMatches(body: string, headerValue: string): boolean {
  const expected = createHash('sha256').update(body, 'utf8').digest('base64')
  // RFC 9530 allows several algorithms and a list; only sha-256 is
  // accepted here, since it is what this library emits and what the
  // spec's example shows. Anything else fails closed rather than being
  // skipped — a Content-Digest that is not checked is worse than none,
  // because the signature appears to cover the body and does not.
  const match = /(?:^|,)\s*sha-256=:([A-Za-z0-9+/=]+):/.exec(headerValue)
  if (!match) return false
  return match[1] === expected
}

/**
 * Verify the signature against the capability's controller.
 *
 * The delegated capability names the party it was delegated *to*, so
 * that party's key is what must have signed the invocation — the same
 * rule the embedded Data Integrity path applies.
 */
export function verifyHttpSignature(
  request: HttpSignatureRequest,
  capability: Capability,
): HttpSignatureResult {
  if (!request.signatureInput || !request.signature) {
    return fail('request carries no Signature-Input/Signature')
  }

  const parsed = parseSignatureInput(request.signatureInput)
  if (!parsed) return fail('Signature-Input is malformed')
  if (parsed.alg && parsed.alg !== 'ed25519') return fail(`unsupported signature alg: ${parsed.alg}`)
  if (!parsed.keyid) return fail('Signature-Input is missing keyid')
  if (parsed.created === undefined) {
    // `created` is inside the signed params, so it cannot be forged —
    // but only if it is present. Without it there is no freshness bound
    // at all, which is the whole point of covering it.
    return fail('Signature-Input is missing created')
  }

  const did = didFromVerificationMethod(parsed.keyid)
  if (!isDidKey(did)) return fail(`keyid ${parsed.keyid} is not a did:key`)
  if (did !== capability.controller && !parsed.keyid.startsWith(`${capability.controller}#`)) {
    return fail(`signature keyid ${parsed.keyid} is not controlled by capability controller ${capability.controller}`)
  }

  if (!request.contentDigest) return fail('request is missing Content-Digest')
  if (!digestMatches(request.body, request.contentDigest)) {
    return fail('Content-Digest does not match the request body')
  }

  const signature = parseSignature(request.signature, parsed.label)
  if (!signature) return fail('Signature header is malformed')

  const publicKey = ed25519PublicKeyFromDidKey(did)
  if (!publicKey) return fail(`could not resolve an Ed25519 key from ${did}`)

  // Rebuilt from what was actually received, never from the sender's
  // claim: `Signature-Input` supplies only keyid/created, and every
  // covered value comes from the request itself.
  const base = buildSignatureBase({
    method: request.method,
    path: pathOf(request.url),
    capabilityInvocation: request.capabilityInvocation,
    contentDigest: request.contentDigest,
    contentType: request.contentType,
    keyid: parsed.keyid,
    created: parsed.created,
  })

  const keyObject = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url') },
    format: 'jwk',
  })

  let ok = false
  try {
    ok = cryptoVerify(null, Buffer.from(base, 'utf8'), keyObject, signature)
  } catch {
    return fail('signature verification threw')
  }
  if (!ok) return fail('HTTP message signature failed verification')

  return { verified: true, created: parsed.created, keyid: parsed.keyid }
}
