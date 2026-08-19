// Builds this example's demo capability — either a real
// eddsa-jcs-2022-signed one (CONTROLLER_SEED set: a real did:key
// controller, derived deterministically from that seed via Askar —
// the same seed always re-derives the same key, so there's no wallet
// storage to persist) or the placeholder unsigned shape
// (CONTROLLER_SEED unset — today's zero-setup default).
//
// Either way the server itself still runs in unsafeMode: there's no
// live ACA-Py agent here for it to verify a real signature against.
// CONTROLLER_SEED only changes what the WIRE actually carries — a
// genuine Data Integrity proof instead of `proof: { type: 'none' }` —
// not what the server checks.

import type { Capability } from '../../client/src/types.js'
import { createDidKeyFromSeed, createTestAgent } from '../../test/helpers/credoAgent.js'
import { addDataIntegrityProof } from '../../test/helpers/eddsaJcs2022.js'

export interface DemoCapabilityResult {
  capability: Capability
  /** Set only when CONTROLLER_SEED produced a real signed capability — for the startup log. */
  controllerDid?: string
}

export async function buildDemoCapability(opts: {
  invocationTarget: string
  allowedAction: string[]
  controllerSeed?: string
}): Promise<DemoCapabilityResult> {
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString()

  if (!opts.controllerSeed) {
    return {
      capability: {
        id: 'urn:zcap:case-manager-demo',
        controller: 'did:example:demo',
        invocationTarget: opts.invocationTarget,
        allowedAction: opts.allowedAction,
        expires,
        proof: { type: 'none', verificationMethod: 'did:example:demo#unsafe' },
      },
    }
  }

  const agent = await createTestAgent()
  try {
    const controller = await createDidKeyFromSeed(agent, opts.controllerSeed)
    const unsigned = {
      id: `urn:zcap:case-manager-demo:${controller.did}`,
      controller: controller.did,
      invocationTarget: opts.invocationTarget,
      allowedAction: opts.allowedAction,
      expires,
    }
    const secured = await addDataIntegrityProof(agent, controller, unsigned, { proofPurpose: 'capabilityDelegation' })
    return { capability: secured as unknown as Capability, controllerDid: controller.did }
  } finally {
    // Signing happens once at startup; the server itself never needs
    // the agent again (the signed capability is just a fixed string
    // baked into the GraphiQL page / printed curl commands from then on).
    await agent.shutdown()
  }
}
