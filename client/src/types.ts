/**
 * Wire shape for a ZCAP-LD capability, camelCase per the W3C-CCG spec.
 * Mirrors digicred-crms's real `vaults/v1_0/zcap/model.py::Capability`
 * field-for-field, so a capability minted by that module (or by this
 * repo's `zcap:delegate` workflow action) round-trips without
 * translation.
 *
 * NOTE: this package does not verify or evaluate `caveat` — the
 * digicred workflow-template design (`catalog.zcap.graphql.allowedAction`)
 * authorizes by literal query string instead of coarse verbs + caveats,
 * so `caveat` is accepted for shape-compatibility only and never read.
 */
export interface Proof {
  type: string
  verificationMethod: string
  created?: string
  proofPurpose?: string
  [key: string]: unknown
}

export interface Capability {
  '@context'?: string
  id: string
  controller: string
  invocationTarget: string
  parentCapability?: string
  allowedAction: string[]
  expires?: string
  caveat?: Record<string, unknown>[]
  proof?: Proof
}

/**
 * A signed capabilityInvocation document — mirrors what digicred-crms's
 * real `w3c_vc/zcap/manager.py::create_invocation` (served over
 * `POST /w3c-vc/zcaps/invoke`) returns. This package never builds or
 * signs one itself — it's produced by whichever agent holds the
 * invoking DID's key, via the injected `invokeCapability` function.
 */
export interface InvocationProof {
  type: string
  verificationMethod: string
  proofPurpose: 'capabilityInvocation'
  capability: string
  capabilityAction: string
  invocationTarget: string
  created?: string
  [key: string]: unknown
}

export interface SignedInvocation {
  '@context'?: string | string[]
  id: string
  proof: InvocationProof
  [key: string]: unknown
}

/**
 * What actually travels in the `x-zcap-invocation` header: the
 * delegation chain (leaf first; just `[capability]` when there's no
 * further sub-delegation) plus, for a real invocation, the signed
 * proof that the chain's leaf controller is exercising it right now.
 * `invocation` is absent for the dev-only `Auth { isZcapValid }` diagnostic —
 * that's a structural/expiry check on the chain alone, not a real
 * invocation (see `DidGraphQLClient.checkAuth`).
 */
export interface InvocationHeaderPayload {
  chain: Capability[]
  invocation?: SignedInvocation
}

/**
 * Caller-supplied signing function — calls whatever agent holds the
 * chain's leaf controller's key (e.g. companion-app's own agent via
 * `POST /w3c-vc/zcaps/invoke`) and returns the signed result. This
 * package deliberately has no Ed25519/JCS implementation of its own;
 * see the did-graphql README for why.
 */
export type InvokeCapabilityFn = (
  capability: Capability,
  capabilityAction: string,
  invocationTarget: string,
) => Promise<SignedInvocation>

export interface GraphQLRequest {
  query: string
  variables?: Record<string, unknown>
  operationName?: string
}

export interface GraphQLError {
  message: string
  locations?: { line: number; column: number }[]
  path?: (string | number)[]
  extensions?: { code?: string; [key: string]: unknown }
}

export interface GraphQLResponse<T = unknown> {
  data?: T
  errors?: GraphQLError[]
}
