import { createHash, createPublicKey, verify } from 'node:crypto'

import bs58 from 'bs58'
import canonicalize from 'canonicalize'

import { didFromVerificationMethod, ed25519PublicKeyFromDidKey, isDidKey } from './didKey.js'

const CRYPTOSUITE = 'eddsa-jcs-2022'
const PROOF_TYPE = 'DataIntegrityProof'

export function firstProof(proof: unknown): Record<string, unknown> | null {
  if (Array.isArray(proof)) {
    const first = proof[0]
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : null
  }
  if (proof && typeof proof === 'object') return proof as Record<string, unknown>
  return null
}

function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest()
}

/** Spec: sha256(JCS(proofOptions)) || sha256(JCS(document without proof)). */
export function hashEddsaJcs2022(document: Record<string, unknown>, proofOptions: Record<string, unknown>): Buffer {
  const proofCanon = canonicalize(proofOptions)
  const docCanon = canonicalize(document)
  if (!proofCanon || !docCanon) throw new Error('JCS canonicalize returned empty')
  return Buffer.concat([sha256(proofCanon), sha256(docCanon)])
}

/**
 * Verify an eddsa-jcs-2022 Data Integrity proof whose verification
 * method is a did:key. Returns false for a bad signature, a missing
 * proof, or a non-did:key method (caller should treat the last case
 * as "unsupported controller," not "invalid").
 */
export function verifyEddsaJcs2022(
  secured: Record<string, unknown>,
  expectedProofPurpose?: string,
): boolean {
  const proof = firstProof(secured.proof)
  if (!proof) return false
  const { proofValue, ...proofOptions } = proof
  if (typeof proofValue !== 'string' || !proofValue.startsWith('z')) return false
  if (proofOptions.type !== PROOF_TYPE || proofOptions.cryptosuite !== CRYPTOSUITE) return false
  if (expectedProofPurpose && proofOptions.proofPurpose !== expectedProofPurpose) return false

  const verificationMethod = proofOptions.verificationMethod
  if (typeof verificationMethod !== 'string') return false
  const did = didFromVerificationMethod(verificationMethod)
  if (!isDidKey(did)) return false
  const publicKey = ed25519PublicKeyFromDidKey(did)
  if (!publicKey) return false

  let signature: Uint8Array
  try {
    signature = bs58.decode(proofValue.slice(1))
  } catch {
    return false
  }

  const document = Object.fromEntries(Object.entries(secured).filter(([k]) => k !== 'proof'))
  let hash: Buffer
  try {
    hash = hashEddsaJcs2022(document, proofOptions)
  } catch {
    return false
  }

  const keyObject = createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(publicKey).toString('base64url'),
    },
    format: 'jwk',
  })
  try {
    return verify(null, hash, keyObject, signature)
  } catch {
    return false
  }
}
