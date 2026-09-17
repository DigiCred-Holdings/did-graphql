import type { Agent } from '@credo-ts/core'

import { AUTH_QUERY } from '../../client/src/types.js'
import type { Capability, SignedInvocation } from '../../client/src/types.js'
import type { DidKeyPair } from './credoAgent.js'
import { addDataIntegrityProof } from './eddsaJcs2022.js'

export { AUTH_QUERY }
export const GRAPHQL_ENDPOINT = 'https://catalog.example.edu/graphql'

export function rootCapabilityId(invocationTarget: string): string {
  return `urn:zcap:root:${encodeURIComponent(invocationTarget)}`
}

export function materializeRoot(issuerDid: string, invocationTarget = GRAPHQL_ENDPOINT) {
  return {
    '@context': ['https://w3id.org/zcap/v1'],
    id: rootCapabilityId(invocationTarget),
    controller: issuerDid,
    invocationTarget,
  }
}

export interface DelegateOverrides {
  /** Extra capability fields (e.g. `caveat`) — signed along with the rest. */
  caveat?: Record<string, unknown>[]
  /**
   * Override delegation proof options, e.g. `capabilityChain`. Applied
   * before signing: these fields are inside the signature, so a test
   * that edited them afterwards would break the proof and then pass for
   * the wrong reason.
   */
  proofOptions?: Record<string, unknown>
}

export async function delegateGraphqlZcap(
  agent: Agent,
  issuer: DidKeyPair,
  invoker: DidKeyPair,
  invocationTarget = GRAPHQL_ENDPOINT,
  allowedAction: string[] = [AUTH_QUERY],
  overrides: DelegateOverrides = {},
): Promise<Capability> {
  const root = materializeRoot(issuer.did, invocationTarget)
  const unsigned = {
    '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
    id: `urn:zcap:delegated:${crypto.randomUUID()}`,
    controller: invoker.did,
    invocationTarget,
    parentCapability: root.id,
    allowedAction,
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...(overrides.caveat ? { caveat: overrides.caveat } : {}),
  }
  const secured = await addDataIntegrityProof(agent, issuer, unsigned, {
    proofPurpose: 'capabilityDelegation',
    capabilityChain: [root.id],
    ...(overrides.proofOptions ?? {}),
  })
  return secured as unknown as Capability
}

export async function invokeGraphqlZcap(
  agent: Agent,
  invoker: DidKeyPair,
  capability: Capability,
  capabilityAction: string,
  invocationTarget: string,
  /**
   * Override the proof's `created`. `created` is inside the signed proof
   * options, so freshness tests have to set it before signing rather
   * than editing it after — editing would break the signature and the
   * test would pass for the wrong reason.
   */
  created?: string,
): Promise<SignedInvocation> {
  const unsigned = {
    '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
    id: `urn:uuid:${crypto.randomUUID()}`,
  }
  const secured = await addDataIntegrityProof(agent, invoker, unsigned, {
    proofPurpose: 'capabilityInvocation',
    capability: capability.id,
    capabilityAction,
    invocationTarget,
    ...(created ? { created } : {}),
  })
  return secured as unknown as SignedInvocation
}
