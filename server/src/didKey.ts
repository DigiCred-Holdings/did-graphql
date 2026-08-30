/**
 * did:key is self-certifying: the DID encodes the public key.
 * Only Ed25519 (`z6Mk…`, multicodec 0xed01) is accepted — that is the
 * key type this stack signs with (eddsa-jcs-2022).
 */

import bs58 from 'bs58'

const ED25519_PREFIX = 0xed
const ED25519_PREFIX_TAIL = 0x01
const ED25519_PUBLIC_KEY_LENGTH = 32

export function isDidKey(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('did:key:')
}

/** DID from a verification method (`did:key:z6Mk…#z6Mk…` → `did:key:z6Mk…`). */
export function didFromVerificationMethod(verificationMethod: string): string {
  const hash = verificationMethod.indexOf('#')
  return hash === -1 ? verificationMethod : verificationMethod.slice(0, hash)
}

/** True if `verificationMethod` is the controller DID or a fragment under it. */
export function vmControlledBy(verificationMethod: string, controller: string): boolean {
  return verificationMethod === controller || verificationMethod.startsWith(`${controller}#`)
}

/**
 * 32-byte Ed25519 public key from a `did:key:z…` string, or null if
 * it is not an Ed25519 did:key.
 */
export function ed25519PublicKeyFromDidKey(did: string): Uint8Array | null {
  if (!did.startsWith('did:key:z')) return null
  let multicodec: Uint8Array
  try {
    multicodec = bs58.decode(did.slice('did:key:z'.length))
  } catch {
    return null
  }
  if (multicodec.length !== 2 + ED25519_PUBLIC_KEY_LENGTH) return null
  if (multicodec[0] !== ED25519_PREFIX || multicodec[1] !== ED25519_PREFIX_TAIL) return null
  return multicodec.subarray(2)
}
