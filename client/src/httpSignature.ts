// RFC 9421 HTTP Message Signatures — the ZCAP spec's own way of proving
// an invocation.
//
// The spec's Example 9 shows exactly this set of covered components:
//
//   Signature-Input: zcap=("@method" "@path" "capability-invocation"
//     "content-digest" "content-type");alg="ed25519";created=…;keyid="did:…#key-1"
//   Signature: zcap=:<base64 ed25519>:
//
// Signing the request rather than a standalone document is what binds
// the proof to *this* HTTP request: its method, its path, the capability
// it carries, and — via Content-Digest — its exact body. The embedded
// Data Integrity invocation this library also supports binds the target
// URL and the query text but nothing else about the request.

import { sha256 } from '@noble/hashes/sha2.js'

import type { Capability } from './types.js'

/** The signature label. `zcap` in the spec's examples. */
export const SIGNATURE_LABEL = 'zcap'

/**
 * Covered components, in order. Order is part of the signature base, so
 * it is fixed here rather than configurable — a verifier rebuilds the
 * base from `Signature-Input`, so a different order would still verify,
 * but matching the spec's example keeps interop boringly predictable.
 */
export const COVERED_COMPONENTS = [
  '@method',
  '@path',
  'capability-invocation',
  'content-digest',
  'content-type',
] as const

/**
 * Signs the RFC 9421 signature base. This package never holds keys, so
 * this is supplied by the caller, exactly as `invokeCapability` is.
 *
 * `keyid` must be resolvable *before* signing: it is inside
 * `@signature-params`, which is itself part of what gets signed.
 */
export interface HttpSignatureSigner {
  /** Verification method id — e.g. `did:key:z6Mk…#z6Mk…`. */
  keyid: string | (() => string | Promise<string>)
  /** Ed25519 signature over the signature base, raw (64 bytes). */
  sign(signatureBase: string): Uint8Array | Promise<Uint8Array>
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function utf8(input: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input)
  return Uint8Array.from(Buffer.from(input, 'utf-8'))
}

/**
 * `Content-Digest: sha-256=:<base64>:` per RFC 9530.
 *
 * This is what actually binds the request body — the signature covers
 * the digest, not the bytes. Without it, the signature would say nothing
 * about which GraphQL query was sent.
 */
export function contentDigest(body: string): string {
  return `sha-256=:${toBase64(sha256(utf8(body)))}:`
}

/** The `@signature-params` value — also the `Signature-Input` value. */
export function signatureParams(keyid: string, created: number): string {
  const components = COVERED_COMPONENTS.map((c) => `"${c}"`).join(' ')
  return `(${components});alg="ed25519";created=${created};keyid="${keyid}"`
}

/**
 * Build the RFC 9421 signature base.
 *
 * One line per covered component as `"name": value`, newline-separated,
 * ending with `"@signature-params": <params>` and **no trailing
 * newline**. Both sides must agree byte-for-byte, so this function is
 * shared: the server imports it rather than reimplementing it, which is
 * the only reliable way to keep two implementations of a canonical
 * string in step.
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

/** `@path` — the path only, no query string, per RFC 9421. */
export function pathOf(endpoint: string): string {
  try {
    return new URL(endpoint).pathname
  } catch {
    return endpoint
  }
}

export interface SignedHttpHeaders {
  'content-digest': string
  'signature-input': string
  signature: string
}

/**
 * Produce the three headers that carry an RFC 9421 proof.
 *
 * `capabilityInvocation` is passed in rather than rebuilt, because the
 * signature covers that header's exact bytes — regenerating it here
 * risks signing a value different from the one actually sent (gzip is
 * deterministic for a given input, but this removes the question).
 */
export async function signRequest(input: {
  signer: HttpSignatureSigner
  method: string
  endpoint: string
  capabilityInvocation: string
  body: string
  contentType?: string
  /** Injectable for tests. Seconds since the epoch, as RFC 9421 uses. */
  created?: number
  /** Unused today; present so a signer can log or scope by capability. */
  capability?: Capability
}): Promise<SignedHttpHeaders> {
  const keyid = typeof input.signer.keyid === 'function' ? await input.signer.keyid() : input.signer.keyid
  const created = input.created ?? Math.floor(Date.now() / 1000)
  const digest = contentDigest(input.body)
  const contentType = input.contentType ?? 'application/json'

  const base = buildSignatureBase({
    method: input.method,
    path: pathOf(input.endpoint),
    capabilityInvocation: input.capabilityInvocation,
    contentDigest: digest,
    contentType,
    keyid,
    created,
  })

  const signature = await input.signer.sign(base)
  return {
    'content-digest': digest,
    'signature-input': `${SIGNATURE_LABEL}=${signatureParams(keyid, created)}`,
    signature: `${SIGNATURE_LABEL}=:${toBase64(signature)}:`,
  }
}
