import { createHash } from 'node:crypto'

import type { Agent } from '@credo-ts/core'
import bs58 from 'bs58'
import canonicalize from 'canonicalize'

import type { DidKeyPair } from './credoAgent.js'

const CRYPTOSUITE = 'eddsa-jcs-2022'
const PROOF_TYPE = 'DataIntegrityProof'

function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest()
}

/** Spec: sha256(JCS(proofOptions)) || sha256(JCS(document)) */
export function hashEddsaJcs2022(document: Record<string, unknown>, proofOptions: Record<string, unknown>): Uint8Array {
  const proofCanon = canonicalize(proofOptions)
  const docCanon = canonicalize(document)
  if (!proofCanon || !docCanon) throw new Error('JCS canonicalize returned empty')
  return Buffer.concat([sha256(proofCanon), sha256(docCanon)])
}

function asSignature(result: unknown): Uint8Array {
  if (result instanceof Uint8Array) return result
  if (Buffer.isBuffer(result)) return new Uint8Array(result)
  if (result && typeof result === 'object' && 'signature' in result) {
    const sig = (result as { signature: Uint8Array }).signature
    return sig instanceof Uint8Array ? sig : new Uint8Array(sig)
  }
  throw new Error(`unexpected kms.sign return: ${typeof result}`)
}

/**
 * Sign `document` with Credo's KMS using Data Integrity eddsa-jcs-2022.
 * Extra proof-option fields (capabilityChain, capabilityAction, …) are hashed.
 */
export async function addDataIntegrityProof(
  agent: Agent,
  signer: DidKeyPair,
  document: Record<string, unknown>,
  extraProofOptions: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (document.proof) throw new Error('document already has a proof')

  const proofOptions: Record<string, unknown> = {
    type: PROOF_TYPE,
    cryptosuite: CRYPTOSUITE,
    proofPurpose: extraProofOptions.proofPurpose ?? 'assertionMethod',
    verificationMethod: signer.verificationMethod,
    created: extraProofOptions.created ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...extraProofOptions,
  }

  const hash = hashEddsaJcs2022(document, proofOptions)
  const signed = await agent.kms.sign({
    keyId: signer.keyId,
    algorithm: 'EdDSA',
    data: hash,
  })
  const proofValue = `z${bs58.encode(asSignature(signed))}`

  return {
    ...document,
    proof: { ...proofOptions, proofValue },
  }
}

export async function verifyDataIntegrityProof(
  agent: Agent,
  signer: DidKeyPair,
  secured: Record<string, unknown>,
): Promise<boolean> {
  const proof = secured.proof
  if (!proof || typeof proof !== 'object') return false
  const { proofValue, ...proofOptions } = proof as Record<string, unknown> & { proofValue?: string }
  if (typeof proofValue !== 'string' || !proofValue.startsWith('z')) return false
  if (proofOptions.cryptosuite !== CRYPTOSUITE || proofOptions.type !== PROOF_TYPE) return false

  const document = Object.fromEntries(Object.entries(secured).filter(([k]) => k !== 'proof'))
  const hash = hashEddsaJcs2022(document, proofOptions)
  const signature = new Uint8Array(bs58.decode(proofValue.slice(1)))

  const result = await agent.kms.verify({
    key: { keyId: signer.keyId },
    algorithm: 'EdDSA',
    data: hash,
    signature,
  })
  return result.verified === true
}
