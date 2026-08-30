// ProblemDetail type URI registry for this library's ZCAP-LD verification
// result (RFC 9457 shape, extended with a custom `typeURI` scheme — this
// isn't a real IANA/W3C-registered problem-type namespace, just a stable
// slug space for this library's own VerificationResult output).
//
// Scheme: urn:zcap:problemDetail:{severity}:{SCREAMING_SNAKE_SLUG}
//   - error   — verification failed; the request must be rejected.
//   - warning — verification still succeeded, but something about the
//               presented capability is worth surfacing (e.g. to logs
//               or a diagnostic query) — never a rejection reason on
//               its own.
//
// Ported/adapted from the equivalent Python registry
// (plugins/w3c_vc/w3c_vc/problem_details.py in digicred-crms), which maps
// onto real W3C spec URIs — this one doesn't, since these failure modes
// are specific to this library's own request-time lookup/verification
// sequence (did:key root controller resolution, the zcap_capabilities
// table, Host-header target matching) rather than the VC/DI specs
// themselves.

export type ProblemSeverity = 'error' | 'warning'

export interface ProblemType {
  /** `urn:zcap:problemDetail:{severity}:{slug}` */
  readonly typeURI: string
  readonly severity: ProblemSeverity
  readonly title: string
}

function problemType(severity: ProblemSeverity, slug: string, title: string): ProblemType {
  return { typeURI: `urn:zcap:problemDetail:${severity}:${slug}`, severity, title }
}

// ---------------------------------------------------------------------------
// Errors — verification fails; the request must be rejected.
// ---------------------------------------------------------------------------

/** A capability (leaf or root) is structurally invalid — missing a required field, or a field has the wrong shape. */
export const MALFORMED_CAPABILITY = problemType(
  'error',
  'MALFORMED_CAPABILITY',
  'The capability is missing a required field or a field has an invalid shape.',
)

/** The presented capability's controller isn't a did:key — this library only verifies did:key root controllers locally. */
export const UNSUPPORTED_CONTROLLER = problemType(
  'error',
  'UNSUPPORTED_CONTROLLER',
  "The capability's controller is not a did:key; local verification only supports did:key root controllers.",
)

/** The proof's cryptosuite isn't eddsa-jcs-2022 — the only one this library verifies. */
export const UNSUPPORTED_CRYPTOSUITE = problemType(
  'error',
  'UNSUPPORTED_CRYPTOSUITE',
  'The proof was created with a cryptosuite this library does not verify.',
)

/** A capabilityDelegation or capabilityInvocation Data Integrity proof failed cryptographic verification. */
export const PROOF_INVALID = problemType(
  'error',
  'PROOF_INVALID',
  'A proof on the capability or invocation failed cryptographic verification.',
)

/** No row in zcap_capabilities matches this (controller, id, invocationTarget) — the root controller/target pair isn't a known, trusted root. */
export const ROOT_CAPABILITY_UNKNOWN = problemType(
  'error',
  'ROOT_CAPABILITY_UNKNOWN',
  'No trusted root capability is registered for this controller and invocation target.',
)

/** The chain's leaf capability's parentCapability doesn't match the id of the root capability resolved from the database lookup. */
export const PARENT_CAPABILITY_MISMATCH = problemType(
  'error',
  'PARENT_CAPABILITY_MISMATCH',
  "The capability's parentCapability does not match the resolved root capability's id.",
)

/** The capability's invocationTarget doesn't match the target expected for this request (derived from the Host header + fixed path). */
export const INVOCATION_TARGET_MISMATCH = problemType(
  'error',
  'INVOCATION_TARGET_MISMATCH',
  'The invocationTarget does not match the target expected for this request.',
)

/** A delegated capability's allowedAction (or invocationTarget) is broader than its parent's — attenuation-only is violated. */
export const ATTENUATION_INVALID = problemType(
  'error',
  'ATTENUATION_INVALID',
  "A delegated capability's authority is broader than its parent's.",
)

/** The leaf capability (or, if checked, the root) has an `expires` timestamp in the past. */
export const EXPIRED = problemType(
  'error',
  'EXPIRED',
  'The capability has expired.',
)

/** The requested GraphQL query isn't within the leaf capability's allowedAction. */
export const ACTION_NOT_ALLOWED = problemType(
  'error',
  'ACTION_NOT_ALLOWED',
  "The requested operation is not within the capability's allowedAction.",
)

/** A real query (not the `zcap { valid }` diagnostic) was made with no capabilityInvocation present. */
export const INVOCATION_MISSING = problemType(
  'error',
  'INVOCATION_MISSING',
  'The request requires a signed invocation, but none was presented.',
)

// ---------------------------------------------------------------------------
// Warnings — verification still succeeds; surfaced for visibility only.
// ---------------------------------------------------------------------------

/** The root capability carries extra fields (e.g. legacy authorization fields) that this library ignores. */
export const LEGACY_ROOT_FIELDS = problemType(
  'warning',
  'LEGACY_ROOT_FIELDS',
  'The root capability includes extra fields that are ignored.',
)

/** The capability is still valid but its `expires` is within a short window — worth surfacing before it lapses. */
export const EXPIRES_SOON = problemType(
  'warning',
  'EXPIRES_SOON',
  'The capability is valid but will expire soon.',
)

// ---------------------------------------------------------------------------
// Registry + builder
// ---------------------------------------------------------------------------

export const PROBLEM_TYPES = {
  MALFORMED_CAPABILITY,
  UNSUPPORTED_CONTROLLER,
  UNSUPPORTED_CRYPTOSUITE,
  PROOF_INVALID,
  ROOT_CAPABILITY_UNKNOWN,
  PARENT_CAPABILITY_MISMATCH,
  INVOCATION_TARGET_MISMATCH,
  ATTENUATION_INVALID,
  EXPIRED,
  ACTION_NOT_ALLOWED,
  INVOCATION_MISSING,
  LEGACY_ROOT_FIELDS,
  EXPIRES_SOON,
} as const satisfies Record<string, ProblemType>

export type ProblemSlug = keyof typeof PROBLEM_TYPES

export interface ProblemDetail {
  typeURI: string
  title: string
  /** Free-form, request-specific context (e.g. which field mismatched, the actual vs. expected value). */
  detail: string
  /** Reserved for a future machine-readable sub-code; unused for now. */
  code?: string
}

/** Build a ProblemDetail from a registered ProblemType plus request-specific detail text. */
export function problemDetail(pt: ProblemType, detail: string): ProblemDetail {
  return { typeURI: pt.typeURI, title: pt.title, detail }
}
