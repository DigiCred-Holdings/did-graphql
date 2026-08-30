/**
 * Local ZCAP-LD verification for did:key + eddsa-jcs-2022 — the only
 * root-controller/DID method this library verifies. Pure crypto and
 * structural checks only:
 *
 *   - No agent call, ever. The tenant's ACA-Py agent is never consulted.
 *   - No database access. The caller (the consuming resource server)
 *     is responsible for resolving which root capability is trusted
 *     for a given request — by looking it up in its own store keyed
 *     by (controller, id, invocationTarget) — and passes the result
 *     in as `rootCapability`. This module never reconstructs a root
 *     capability on its own; it only checks the one it's handed.
 *   - No tenant/multi-tenancy concept at all. "Which tenant does this
 *     request belong to" is a question for the caller's own lookup,
 *     answered before this module is ever invoked.
 *
 * did:key is self-certifying (the DID literally encodes the Ed25519
 * public key), so verifying a proof needs nothing but the capability
 * documents themselves — no DID resolution, no network call.
 */

import {
  ACTION_NOT_ALLOWED,
  EXPIRED,
  INVOCATION_MISSING,
  INVOCATION_TARGET_MISMATCH,
  MALFORMED_CAPABILITY,
  PARENT_CAPABILITY_MISMATCH,
  PROOF_INVALID,
  UNSUPPORTED_CONTROLLER,
  UNSUPPORTED_CRYPTOSUITE,
  problemDetail,
  type ProblemDetail,
} from './problemDetails.js'
import { didFromVerificationMethod, isDidKey, vmControlledBy } from './didKey.js'
import { firstProof, verifyEddsaJcs2022 } from './eddsaJcs2022.js'

const PROOF_PURPOSE_DELEGATION = 'capabilityDelegation'
const PROOF_PURPOSE_INVOCATION = 'capabilityInvocation'
const CRYPTOSUITE = 'eddsa-jcs-2022'

export interface Proof {
  type?: string
  cryptosuite?: string
  proofPurpose?: string
  verificationMethod?: string
  proofValue?: string
  [key: string]: unknown
}

export interface Capability {
  '@context'?: string | string[]
  id: string
  controller: string
  invocationTarget: string
  parentCapability?: string
  allowedAction?: string[]
  expires?: string
  proof?: Proof | Proof[]
  [key: string]: unknown
}

export interface SignedInvocation {
  '@context'?: string | string[]
  id?: string
  proof?: Proof | Proof[]
  [key: string]: unknown
}

export interface VerificationResult {
  verified: boolean
  controller: string | null
  invocationTarget: string | null
  allowedAction: string[] | null
  errors: ProblemDetail[]
  warnings: ProblemDetail[]
}

function ok(leaf: Capability, warnings: ProblemDetail[] = []): VerificationResult {
  return {
    verified: true,
    controller: leaf.controller,
    invocationTarget: leaf.invocationTarget,
    allowedAction: leaf.allowedAction ?? null,
    errors: [],
    warnings,
  }
}

function fail(leaf: Capability | undefined, ...errors: ProblemDetail[]): VerificationResult {
  return {
    verified: false,
    controller: leaf?.controller ?? null,
    invocationTarget: leaf?.invocationTarget ?? null,
    allowedAction: leaf?.allowedAction ?? null,
    errors,
    warnings: [],
  }
}

function structuralProblem(cap: Capability | undefined): ProblemDetail | null {
  if (!cap || typeof cap !== 'object') {
    return problemDetail(MALFORMED_CAPABILITY, 'capability is missing or not an object')
  }
  for (const field of ['id', 'controller', 'invocationTarget'] as const) {
    if (!cap[field] || typeof cap[field] !== 'string') {
      return problemDetail(MALFORMED_CAPABILITY, `capability is missing required field "${field}"`)
    }
  }
  return null
}

/**
 * Checks the leaf capability alone — proof, expiry, linkage to the
 * given (already-resolved, already-trusted) root, and the request's
 * expected invocation target. Does not check `allowedAction`
 * membership against a query, and does not check any invocation —
 * see {@link verifyInvocation} for the full gate used by real queries.
 */
export function verifyChain(
  leaf: Capability | undefined,
  rootCapability: Capability,
  expectedInvocationTarget: string,
  now: Date = new Date(),
): VerificationResult {
  const structural = structuralProblem(leaf)
  if (structural) return fail(leaf, structural)
  const cap = leaf as Capability

  if (!isDidKey(rootCapability.controller)) {
    return fail(
      cap,
      problemDetail(UNSUPPORTED_CONTROLLER, `root controller ${rootCapability.controller} is not a did:key`),
    )
  }
  if (!isDidKey(cap.controller)) {
    return fail(cap, problemDetail(UNSUPPORTED_CONTROLLER, `leaf controller ${cap.controller} is not a did:key`))
  }

  // Host-header cross-check: the capability's own invocationTarget
  // must match what this specific request expects, independent of
  // whatever invocationTarget the DB lookup itself was keyed on.
  if (cap.invocationTarget !== expectedInvocationTarget) {
    return fail(
      cap,
      problemDetail(
        INVOCATION_TARGET_MISMATCH,
        `capability invocationTarget "${cap.invocationTarget}" does not match expected "${expectedInvocationTarget}"`,
      ),
    )
  }

  // Explicit parentCapability check — separate from the DB lookup
  // that resolved `rootCapability` in the first place, so a mismatch
  // here is its own distinct, more specific rejection reason.
  if (cap.parentCapability !== rootCapability.id) {
    return fail(
      cap,
      problemDetail(
        PARENT_CAPABILITY_MISMATCH,
        `leaf parentCapability "${String(cap.parentCapability)}" does not match resolved root id "${rootCapability.id}"`,
      ),
    )
  }

  if (!cap.expires) return fail(cap, problemDetail(MALFORMED_CAPABILITY, 'capability is missing "expires"'))
  const deadline = new Date(cap.expires)
  if (Number.isNaN(deadline.getTime())) {
    return fail(cap, problemDetail(MALFORMED_CAPABILITY, `capability "expires" is not parseable: ${cap.expires}`))
  }
  if (now > deadline) return fail(cap, problemDetail(EXPIRED, `capability expired at ${cap.expires}`))

  const proof = firstProof(cap.proof)
  const vm = typeof proof?.verificationMethod === 'string' ? proof.verificationMethod : undefined
  if (!vm) return fail(cap, problemDetail(MALFORMED_CAPABILITY, 'capability proof is missing verificationMethod'))
  if (!isDidKey(didFromVerificationMethod(vm))) {
    return fail(cap, problemDetail(UNSUPPORTED_CONTROLLER, `proof verificationMethod ${vm} is not a did:key`))
  }
  if (proof?.cryptosuite !== CRYPTOSUITE) {
    return fail(cap, problemDetail(UNSUPPORTED_CRYPTOSUITE, `unsupported cryptosuite: ${String(proof?.cryptosuite)}`))
  }
  // Delegation proofs are signed by the PARENT's controller — the
  // root, in this system's single-level chains — not by the leaf's
  // own controller (who is merely the holder being delegated to).
  if (!vmControlledBy(vm, rootCapability.controller)) {
    return fail(
      cap,
      problemDetail(
        PROOF_INVALID,
        `leaf signed by ${vm}, which is not controlled by root controller ${rootCapability.controller}`,
      ),
    )
  }
  if (!verifyEddsaJcs2022(cap as unknown as Record<string, unknown>, PROOF_PURPOSE_DELEGATION)) {
    return fail(cap, problemDetail(PROOF_INVALID, 'leaf capabilityDelegation proof failed verification'))
  }

  return ok(cap)
}

/**
 * `allowedAction` membership check alone — the caller supplies the
 * matcher (query-subset semantics live in zcap.ts, not here, since
 * they're GraphQL-specific and unrelated to cryptographic verification).
 * Assumes {@link verifyChain} already passed for `leaf`.
 */
export function verifyActionAllowed(
  leaf: Capability,
  rawQueryText: string,
  matchesAllowedAction: (allowedAction: string[] | undefined, rawQueryText: string) => boolean,
): VerificationResult {
  if (!matchesAllowedAction(leaf.allowedAction, rawQueryText)) {
    return fail(leaf, problemDetail(ACTION_NOT_ALLOWED, `"${rawQueryText}" is not within allowedAction`))
  }
  return ok(leaf)
}

/**
 * The invocation-specific checks alone: a real `capabilityInvocation`
 * proof, signed by the leaf's own controller (the current holder —
 * distinct from the leaf's *delegation* proof, which is signed by the
 * parent/root controller and is checked by {@link verifyChain}).
 * Assumes {@link verifyChain} (and, for a real query, `allowedAction`
 * membership) already passed for `leaf`.
 */
export function verifyInvocationProof(
  leaf: Capability,
  invocation: SignedInvocation | undefined,
  rawQueryText: string,
): VerificationResult {
  const cap = leaf

  if (!invocation) {
    return fail(cap, problemDetail(INVOCATION_MISSING, 'no capabilityInvocation was presented'))
  }

  const proof = firstProof(invocation.proof)
  if (!proof) return fail(cap, problemDetail(MALFORMED_CAPABILITY, 'invocation is missing a proof'))
  if (proof.proofPurpose !== PROOF_PURPOSE_INVOCATION) {
    return fail(cap, problemDetail(MALFORMED_CAPABILITY, 'invocation proofPurpose must be capabilityInvocation'))
  }
  const vm = typeof proof.verificationMethod === 'string' ? proof.verificationMethod : undefined
  if (!vm || !vmControlledBy(vm, cap.controller)) {
    return fail(
      cap,
      problemDetail(PROOF_INVALID, `invocation signed by ${String(vm)}, which is not controlled by leaf controller ${cap.controller}`),
    )
  }
  if (proof.capability !== cap.id) {
    return fail(cap, problemDetail(MALFORMED_CAPABILITY, `invocation capability "${String(proof.capability)}" does not match leaf id "${cap.id}"`))
  }
  if (proof.invocationTarget !== cap.invocationTarget) {
    return fail(cap, problemDetail(INVOCATION_TARGET_MISMATCH, 'invocation invocationTarget does not match leaf capability'))
  }
  if (proof.capabilityAction !== rawQueryText) {
    return fail(cap, problemDetail(MALFORMED_CAPABILITY, 'invocation capabilityAction does not match the query'))
  }
  if (!verifyEddsaJcs2022(invocation as unknown as Record<string, unknown>, PROOF_PURPOSE_INVOCATION)) {
    return fail(cap, problemDetail(PROOF_INVALID, 'invocation proof failed verification'))
  }

  return ok(cap)
}
