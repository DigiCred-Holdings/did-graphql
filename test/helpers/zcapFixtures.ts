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

export async function delegateGraphqlZcap(
  agent: Agent,
  issuer: DidKeyPair,
  holder: DidKeyPair,
  invocationTarget = GRAPHQL_ENDPOINT,
  allowedAction: string[] = [AUTH_QUERY],
): Promise<Capability> {
  const root = materializeRoot(issuer.did, invocationTarget)
  const unsigned = {
    '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
    id: `urn:zcap:delegated:${crypto.randomUUID()}`,
    controller: holder.did,
    invocationTarget,
    parentCapability: root.id,
    allowedAction,
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }
  const secured = await addDataIntegrityProof(agent, issuer, unsigned, {
    proofPurpose: 'capabilityDelegation',
    capabilityChain: [root.id],
  })
  return secured as unknown as Capability
}

export async function invokeGraphqlZcap(
  agent: Agent,
  holder: DidKeyPair,
  capability: Capability,
  capabilityAction: string,
  invocationTarget: string,
): Promise<SignedInvocation> {
  const unsigned = {
    '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
    id: `urn:uuid:${crypto.randomUUID()}`,
  }
  const secured = await addDataIntegrityProof(agent, holder, unsigned, {
    proofPurpose: 'capabilityInvocation',
    capability: capability.id,
    capabilityAction,
    invocationTarget,
  })
  return secured as unknown as SignedInvocation
}
