import type { Capability, InvocationHeaderPayload } from './types.js'

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

// Only the no-invocation (diagnostic) shape is worth caching: the same
// capability is reused across many diagnostic checks, so keying on it
// avoids redundant re-serialization. A real invoked payload carries a
// freshly-signed `invocation` object on every call by construction —
// there is nothing to reuse there, so it's never cached.
const diagnosticHeaderCache = new WeakMap<Capability, string>()

/** Encode a header payload for the `x-zcap-invocation` convention (base64-encoded JSON). */
export function encodeInvocationHeader(payload: InvocationHeaderPayload): string {
  if (!payload.invocation) {
    const leaf = payload.chain[0]
    if (leaf) {
      const cached = diagnosticHeaderCache.get(leaf)
      if (cached !== undefined) return cached
      const encoded = toBase64(JSON.stringify(payload))
      diagnosticHeaderCache.set(leaf, encoded)
      return encoded
    }
  }
  return toBase64(JSON.stringify(payload))
}

export function decodeInvocationHeader(header: string): InvocationHeaderPayload {
  return JSON.parse(fromBase64(header))
}

/**
 * Client-side expiry check — lets the holder decide to request a
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
