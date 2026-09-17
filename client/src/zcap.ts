import { gzipSync, strToU8 } from 'fflate'

import type { Capability, InvocationHeaderPayload, SignedInvocation } from './types.js'

/**
 * Isomorphic base64 (works in Node, browsers, and React Native without
 * assuming a `Buffer` polyfill is present).
 */
function toBase64(input: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(input, 'utf-8').toString('base64')
  // btoa only handles Latin1 — round-trip through URI-encoding for
  // arbitrary UTF-8 (capability text is plain JSON, but DID strings
  // etc. could in principle carry non-ASCII).
  return btoa(unescape(encodeURIComponent(input)))
}

function fromBase64(input: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(input, 'base64').toString('utf-8')
  return decodeURIComponent(escape(atob(input)))
}

/**
 * Byte-oriented base64url. Deliberately NOT built on `toBase64` above:
 * that one routes through `unescape(encodeURIComponent(...))`, which is
 * a UTF-8 round-trip and corrupts arbitrary bytes. Gzip output is
 * arbitrary bytes, so it needs this path.
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let b64: string
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(bytes).toString('base64')
  } else {
    // Chunked: String.fromCharCode(...bytes) blows the argument limit
    // on anything large, and a capability is several KB.
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    b64 = btoa(binary)
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** `base64url(gzip(json(value)))` — the encoding the ZCAP spec's HTTP binding specifies. */
function gzipToBase64Url(value: unknown): string {
  return bytesToBase64Url(gzipSync(strToU8(JSON.stringify(value))))
}

/**
 * The gzipped capability is both the expensive part to produce and the
 * part that does not change between requests — a client invokes the
 * same capability over and over, with only a fresh invocation each
 * time. Keyed on the capability object so it is collected with it.
 */
const capabilityParamCache = new WeakMap<Capability, string>()

function capabilityParam(capability: Capability): string {
  const cached = capabilityParamCache.get(capability)
  if (cached !== undefined) return cached
  const encoded = gzipToBase64Url(capability)
  capabilityParamCache.set(capability, encoded)
  return encoded
}

/**
 * Build the `Capability-Invocation` header value.
 *
 * Follows the ZCAP spec's HTTP binding for the capability itself —
 * "serializing it to JSON, gzipping the result, and then
 * base64url-encoding the gzipped JSON" — which is also what keeps the
 * header under host limits: a real 9-query capability is ~5.9KB of JSON
 * and ~1.8KB encoded this way.
 *
 * One documented divergence: the spec conveys the invocation proof with
 * HTTP Signatures. This library uses an embedded `eddsa-jcs-2022` Data
 * Integrity invocation instead, carried in an `invocation` parameter
 * encoded the same way, because that proof is byte-compatible with the
 * signer on the issuing side. See the README.
 *
 * `invocation` is omitted for the unsigned diagnostic shape.
 */
export function encodeCapabilityInvocation(input: {
  capability: Capability
  invocation?: SignedInvocation
}): string {
  // Bare values, matching the spec's examples
  // (`capability={base64url(gzip(json(capability)))}`). Unpadded
  // base64url contains no character that would need quoting.
  const params = [`capability=${capabilityParam(input.capability)}`]
  if (input.invocation) params.push(`invocation=${gzipToBase64Url(input.invocation)}`)
  return `zcap ${params.join(', ')}`
}

/**
 * @deprecated Legacy `x-zcap-invocation` encoding: base64 of uncompressed
 * JSON, with the leaf wrapped in a `chain` array that has no counterpart
 * in the ZCAP data model. Superseded by `encodeCapabilityInvocation`.
 * Servers still accept it; clients no longer send it. Kept so callers
 * with their own transport can migrate on their own schedule.
 */
export function encodeInvocationHeader(payload: InvocationHeaderPayload): string {
  return toBase64(JSON.stringify(payload))
}

/** @deprecated Counterpart to the deprecated `encodeInvocationHeader`. */
export function decodeInvocationHeader(header: string): InvocationHeaderPayload {
  return JSON.parse(fromBase64(header))
}

/**
 * Client-side expiry check — lets the client decide to request a
 * fresh delegation *before* firing a request that would just be
 * rejected. This is NOT a substitute for the resource server's own
 * verification (no signature check happens here).
 */
export function isExpired(capability: Capability, now: Date = new Date()): boolean {
  if (!capability.expires) return false
  const deadline = new Date(capability.expires)
  if (Number.isNaN(deadline.getTime())) return true
  return now > deadline
}
