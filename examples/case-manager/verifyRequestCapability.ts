// Real, local cryptographic verification of an incoming capability's
// own proof — using did-graphql-server's eddsa-jcs-2022 verifier
// (no Credo/Askar per request). did-graphql-server's own
// checkInvocation/checkAuthOnly still runs separately.
//
// Only the capability's own proof is checked (the shape this example
// produces — a single self-issued, self-signed leaf, no delegation
// chain).

import { verifyEddsaJcs2022 } from '../../server/src/eddsaJcs2022.js'
import type { Capability, InvocationHeaderPayload } from '../../server/src/index.js'

export interface CapabilityVerification {
  ok: boolean
  reason?: string
}

/**
 * `payload` is exactly what did-graphql-server's own decodeInvocationHeader
 * produces. The leaf (last entry in the chain) is what this example
 * itself signs — see controllerCapability.ts.
 */
export function verifyRequestCapability(payload: InvocationHeaderPayload | null): CapabilityVerification {
  const leaf: Capability | undefined = payload?.chain[payload.chain.length - 1]
  if (!leaf) return { ok: false, reason: 'missing capability' }

  const proof = leaf.proof
  if (!proof || (typeof proof === 'object' && 'type' in proof && proof.type === 'none')) {
    // The zero-setup placeholder (CONTROLLER_SEED unset) — nothing to
    // cryptographically verify; did-graphql-server's own unsafeMode
    // gate is the only check that applies.
    return { ok: true }
  }

  const verified = verifyEddsaJcs2022(leaf as unknown as Record<string, unknown>, 'capabilityDelegation')
  return verified ? { ok: true } : { ok: false, reason: 'capability signature verification failed' }
}
