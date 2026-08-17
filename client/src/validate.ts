import type { Capability } from './types.js'
import { InvalidCapabilityError } from './errors.js'

const REQUIRED_FIELDS = ['id', 'controller', 'invocationTarget', 'allowedAction', 'proof'] as const

/**
 * Structural, non-cryptographic sanity check — catches integration
 * mistakes (a malformed/partial capability object, wrong shape from a
 * bad deserialization) before wasting a network round-trip on them.
 * This is NOT signature verification; a capability passing this check
 * can still be forged or expired — the resource server is the actual
 * authority. See catalog-graphql-mock's server-side `zcap.ts` for
 * the equivalent (and equally non-cryptographic) server-side check.
 */
export function validateCapabilityShape(capability: Capability): void {
  const problems: string[] = []

  if (!capability || typeof capability !== 'object') {
    throw new InvalidCapabilityError(['missing capability'])
  }
  for (const field of REQUIRED_FIELDS) {
    if (capability[field] === undefined || capability[field] === null) problems.push(`missing ${field}`)
  }
  if (capability.allowedAction && !Array.isArray(capability.allowedAction)) {
    problems.push('allowedAction must be an array')
  }
  if (capability.proof && typeof capability.proof !== 'object') {
    problems.push('proof must be an object')
  }
  if (capability.proof && !capability.proof.verificationMethod) {
    problems.push('proof missing verificationMethod')
  }

  if (problems.length) throw new InvalidCapabilityError(problems)
}

/** True/false version for callers that want to check without a throw (e.g. UI state). */
export function isValidCapabilityShape(capability: Capability): boolean {
  try {
    validateCapabilityShape(capability)
    return true
  } catch {
    return false
  }
}
