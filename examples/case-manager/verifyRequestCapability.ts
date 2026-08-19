// Real, local cryptographic verification of an incoming capability's
// own proof — using Credo (backed by Askar) directly, no live ACA-Py
// agent involved. This is genuinely additional to
// did-graphql-server's own checkInvocation/checkAuthOnly: those check
// allowedAction membership and expiry (still real, still running
// exactly as configured below), but in unsafeMode they never check a
// signature at all. This fills that one gap for a self-signed
// did:key capability — not a substitute for did-graphql-server's own
// gate, on top of it.
//
// Only the capability's own proof is checked (the shape this example
// produces — a single self-issued, self-signed leaf, no delegation
// chain). A real multi-hop delegation chain, and the separate signed
// *invocation* proof a real wallet also produces, are still what
// did-graphql-server's real checkInvocation verifies via a tenant's
// ACA-Py agent — that's not reimplemented here.

import type { Agent } from '@credo-ts/core'

import type { Capability, InvocationHeaderPayload } from '../../server/src/index.js'
import { verifyDataIntegrityProofByController } from '../../test/helpers/eddsaJcs2022.js'

export interface CapabilityVerification {
  ok: boolean
  reason?: string
}

/**
 * `payload` is exactly what did-graphql-server's own decodeInvocationHeader
 * produces. The leaf (last entry in the chain) is what this example
 * itself signs — see controllerCapability.ts.
 */
export async function verifyRequestCapability(agent: Agent, payload: InvocationHeaderPayload | null): Promise<CapabilityVerification> {
  const leaf: Capability | undefined = payload?.chain[payload.chain.length - 1]
  if (!leaf) return { ok: false, reason: 'missing capability' }

  const proof = leaf.proof
  if (!proof || proof.type === 'none') {
    // The zero-setup placeholder (CONTROLLER_SEED unset) — nothing to
    // cryptographically verify; did-graphql-server's own unsafeMode
    // gate is the only check that applies.
    return { ok: true }
  }

  const verified = await verifyDataIntegrityProofByController(agent, leaf as unknown as Record<string, unknown>)
  return verified ? { ok: true } : { ok: false, reason: 'capability signature verification failed' }
}
