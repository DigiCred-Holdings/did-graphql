/**
 * Local ZCAP-LD verification for did:key + eddsa-jcs-2022.
 *
 * Roots are unsigned and trusted by local dereference (ZCAP-LD) —
 * `materializeRoot` is the same deterministic object `POST /w3c-vc/zcaps/root`
 * would return. Delegation and invocation proofs are public-key checks;
 * did:key carries the Ed25519 key in the DID, so the tenant agent is
 * not consulted.
 */

import type { Capability } from './agentClient.js'
import { didFromVerificationMethod, isDidKey, vmControlledBy } from './didKey.js'
import { firstProof, verifyEddsaJcs2022 } from './eddsaJcs2022.js'
import type { InvocationHeaderPayload, TrustConfig } from './zcap.js'

const PROOF_PURPOSE_DELEGATION = 'capabilityDelegation'
const PROOF_PURPOSE_INVOCATION = 'capabilityInvocation'
const ZCAP_CONTEXT = 'https://w3id.org/zcap/v1'

export function rootCapabilityId(invocationTarget: string): string {
  return `urn:zcap:root:${encodeURIComponent(invocationTarget)}`
}

/** Bare unsigned root — same shape as w3c_vc `materialize_root`. */
export function materializeRoot(controller: string, invocationTarget: string): Capability {
  return {
    '@context': [ZCAP_CONTEXT],
    id: rootCapabilityId(invocationTarget),
    controller,
    invocationTarget,
  }
}

export function reconstructFullChain(leaf: Capability, trust: TrustConfig): Capability[] {
  return [leaf, materializeRoot(trust.trustedRootController, leaf.invocationTarget)]
}

function proofVerificationMethod(proof: unknown): string | undefined {
  const first = firstProof(proof)
  const vm = first?.verificationMethod
  return typeof vm === 'string' ? vm : undefined
}

/** True when every DID involved is did:key so this package can verify without an agent. */
export function canVerifyLocally(
  leaf: Capability,
  trust: TrustConfig,
  invocation?: Record<string, unknown>,
): boolean {
  if (!isDidKey(trust.trustedRootController)) return false
  if (!isDidKey(leaf.controller)) return false
  const leafVm = proofVerificationMethod(leaf.proof)
  if (!leafVm || !isDidKey(didFromVerificationMethod(leafVm))) return false
  if (invocation) {
    const invVm = proofVerificationMethod(invocation.proof)
    if (!invVm || !isDidKey(didFromVerificationMethod(invVm))) return false
  }
  return true
}

export function verifyChainLocally(
  leaf: Capability,
  trust: TrustConfig,
  now: Date = new Date(),
): string | null {
  if (!leaf.id || !leaf.controller || !leaf.invocationTarget) return 'missing capability fields'
  if (trust.expectedInvocationTarget && leaf.invocationTarget !== trust.expectedInvocationTarget) {
    return `invocationTarget mismatch: ${leaf.invocationTarget}`
  }

  const root = materializeRoot(trust.trustedRootController, leaf.invocationTarget)
  if (leaf.parentCapability !== root.id) {
    return `parentCapability link mismatch for ${leaf.id}`
  }
  if (root.controller !== trust.trustedRootController) {
    return 'root controller is not the trusted root'
  }

  if (!leaf.expires) return 'missing expires'
  const deadline = new Date(leaf.expires)
  if (Number.isNaN(deadline.getTime())) return `expires not parseable: ${leaf.expires}`
  if (now > deadline) return `expired at ${leaf.expires}`

  const vm = proofVerificationMethod(leaf.proof)
  if (!vm) return 'leaf missing proof verificationMethod'
  if (!vmControlledBy(vm, trust.trustedRootController)) {
    return `leaf signed by ${vm} which is not controlled by parent controller ${trust.trustedRootController}`
  }

  if (!verifyEddsaJcs2022(leaf as unknown as Record<string, unknown>, PROOF_PURPOSE_DELEGATION)) {
    return 'leaf proof verification failed'
  }
  return null
}

export function verifyInvocationLocally(
  payload: InvocationHeaderPayload,
  trust: TrustConfig,
  rawQueryText: string,
  now: Date = new Date(),
): { code: 'CAPABILITY_INVALID' | 'INVOCATION_INVALID'; message: string } | null {
  const leaf = payload.chain?.[0]
  if (!leaf) return { code: 'CAPABILITY_INVALID', message: 'missing capability' }

  const chainProblem = verifyChainLocally(leaf, trust, now)
  if (chainProblem) return { code: 'CAPABILITY_INVALID', message: chainProblem }

  const invocation = payload.invocation
  if (!invocation) return { code: 'INVOCATION_INVALID', message: 'missing invocation' }

  const proof = firstProof(invocation.proof)
  if (!proof) return { code: 'INVOCATION_INVALID', message: 'invocation missing proof' }
  if (proof.proofPurpose !== PROOF_PURPOSE_INVOCATION) {
    return { code: 'INVOCATION_INVALID', message: 'invocation proofPurpose must be capabilityInvocation' }
  }

  const vm = typeof proof.verificationMethod === 'string' ? proof.verificationMethod : undefined
  if (!vm || !vmControlledBy(vm, leaf.controller)) {
    return {
      code: 'INVOCATION_INVALID',
      message: `invocation signed by ${vm} which is not controlled by leaf controller ${leaf.controller}`,
    }
  }
  if (proof.capability !== leaf.id) {
    return {
      code: 'INVOCATION_INVALID',
      message: `invocation capability ${String(proof.capability)} does not match leaf ${leaf.id}`,
    }
  }
  if (proof.invocationTarget !== leaf.invocationTarget) {
    return { code: 'INVOCATION_INVALID', message: 'invocationTarget does not match leaf capability' }
  }
  if (proof.capabilityAction !== rawQueryText) {
    return { code: 'INVOCATION_INVALID', message: 'invocation capabilityAction does not match the query' }
  }

  if (!verifyEddsaJcs2022(invocation, PROOF_PURPOSE_INVOCATION)) {
    return { code: 'INVOCATION_INVALID', message: 'invocation proof verification failed' }
  }
  return null
}
