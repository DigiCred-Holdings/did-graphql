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

// The leaf ZCAP (especially `allowedAction`) is large and unchanged
// until `setCapability`. Cache its JSON so every signed query only
// stringifies the fresh `invocation`, not the whole chain. WeakMap
// drops the entry when the capability object is replaced.
const leafJsonCache = new WeakMap<Capability, string>()
// Unsigned diagnostic headers (`checkAuth` / unsafeMode) are identical
// for a given leaf — cache the final base64 too (skips toBase64).
const diagnosticHeaderCache = new WeakMap<Capability, string>()

function serializedLeaf(capability: Capability): string {
  const cached = leafJsonCache.get(capability)
  if (cached !== undefined) return cached
  const json = JSON.stringify(capability)
  leafJsonCache.set(capability, json)
  return json
}

/**
 * Encode a header payload for the `x-zcap-invocation` convention (base64-encoded JSON).
 *
 * Single-leaf payloads (the production shape) splice a cached
 * `JSON.stringify(leaf)` with a freshly stringified `invocation`.
 * Multi-link chains fall back to a full `JSON.stringify(payload)`.
 */
export function encodeInvocationHeader(payload: InvocationHeaderPayload): string {
  const leaf = payload.chain[0]
  if (leaf && payload.chain.length === 1) {
    if (!payload.invocation) {
      const cached = diagnosticHeaderCache.get(leaf)
      if (cached !== undefined) return cached
      const encoded = toBase64(`{"chain":[${serializedLeaf(leaf)}]}`)
      diagnosticHeaderCache.set(leaf, encoded)
      return encoded
    }
    return toBase64(`{"chain":[${serializedLeaf(leaf)}],"invocation":${JSON.stringify(payload.invocation)}}`)
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
