import bs58 from 'bs58'
import { hashEddsaJcs2022 } from './eddsaJcs2022.js'
import type { InvocationProof, SignedInvocation } from './types.js'

/** Mirrors digicred-crms `w3c_vc/zcap/model.py::DELEGATED_CONTEXTS`. */
export const ZCAP_CONTEXT = 'https://w3id.org/zcap/v1'
export const DATA_INTEGRITY_CONTEXT = 'https://w3id.org/security/data-integrity/v2'

export const DATA_INTEGRITY_PROOF_TYPE = 'DataIntegrityProof'
export const EDDSA_JCS_2022 = 'eddsa-jcs-2022'
export const PROOF_PURPOSE_INVOCATION = 'capabilityInvocation' as const

/**
 * Concrete proof-options shape (not `Omit<InvocationProof, 'proofValue'>`) —
 * `InvocationProof`'s index signature would collapse `Omit` to lose named fields.
 */
export interface InvocationProofOptions {
  type: string
  cryptosuite: string
  proofPurpose: 'capabilityInvocation'
  verificationMethod: string
  created: string
  capability: string
  capabilityAction: string
  invocationTarget: string
}

export interface UnsignedCapabilityInvocation {
  document: Record<string, unknown>
  proofOptions: InvocationProofOptions
  /** Bytes to pass to the caller's Ed25519 signer (Credo KMS, etc.). */
  hash: Uint8Array
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

function newInvocationId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : '00000000-0000-4000-8000-000000000000'
  return `urn:uuid:${uuid}`
}

/**
 * Builds the unsigned invocation document + proof options and the
 * eddsa-jcs-2022 hash. Does not sign — the holder supplies the signature
 * via `finalizeCapabilityInvocation` (wallet: Credo `kms.sign`).
 */
export function createUnsignedCapabilityInvocation(input: {
  capabilityId: string
  capabilityAction: string
  invocationTarget: string
  verificationMethod: string
  created?: string
  id?: string
}): UnsignedCapabilityInvocation {
  const proofOptions: InvocationProofOptions = {
    type: DATA_INTEGRITY_PROOF_TYPE,
    cryptosuite: EDDSA_JCS_2022,
    proofPurpose: PROOF_PURPOSE_INVOCATION,
    verificationMethod: input.verificationMethod,
    created: input.created ?? nowIso(),
    capability: input.capabilityId,
    capabilityAction: input.capabilityAction,
    invocationTarget: input.invocationTarget,
  }

  const document: Record<string, unknown> = {
    '@context': [ZCAP_CONTEXT, DATA_INTEGRITY_CONTEXT],
    id: input.id ?? newInvocationId(),
  }

  return {
    document,
    proofOptions,
    hash: hashEddsaJcs2022(document, { ...proofOptions }),
  }
}

/** Multibase base58btc (`z` + bs58) — same encoding Credo's MultiBaseEncoder uses. */
export function encodeProofValue(signature: Uint8Array): string {
  return `z${bs58.encode(signature)}`
}

/**
 * Attach a raw Ed25519 signature as `proofValue` and return the wire
 * `SignedInvocation` shape for `x-zcap-invocation`.
 */
export function finalizeCapabilityInvocation(
  document: Record<string, unknown>,
  proofOptions: InvocationProofOptions,
  signature: Uint8Array
): SignedInvocation {
  const proof: InvocationProof = {
    ...proofOptions,
    proofValue: encodeProofValue(signature),
  }
  return {
    '@context': [ZCAP_CONTEXT, DATA_INTEGRITY_CONTEXT],
    id: document.id as string,
    proof,
  }
}
