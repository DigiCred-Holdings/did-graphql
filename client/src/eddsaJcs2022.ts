import { sha256 } from '@noble/hashes/sha2.js'
import canonicalize from 'canonicalize'

/**
 * Spec (eddsa-jcs-2022): sha256(JCS(proofOptions)) || sha256(JCS(document)).
 * Must match CRMS Python (`eddsa_jcs_2022.py::_hash`) and
 * `@digicred-holdings/did-graphql-server`'s `hashEddsaJcs2022` byte-for-byte.
 */
export function hashEddsaJcs2022(
  document: Record<string, unknown>,
  proofOptions: Record<string, unknown>
): Uint8Array {
  const proofCanon = canonicalize(proofOptions)
  const docCanon = canonicalize(document)
  if (!proofCanon || !docCanon) throw new Error('JCS canonicalize returned empty')
  const proofHash = sha256(new TextEncoder().encode(proofCanon))
  const docHash = sha256(new TextEncoder().encode(docCanon))
  const out = new Uint8Array(proofHash.length + docHash.length)
  out.set(proofHash, 0)
  out.set(docHash, proofHash.length)
  return out
}
