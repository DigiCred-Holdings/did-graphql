import {
  AUTH_QUERY,
  type Capability,
  type GraphQLRequest,
  type GraphQLResponse,
  type InvokeCapabilityFn,
  type SignedInvocation,
} from './types.js'
import { encodeCapabilityInvocation, isExpired } from './zcap.js'
import { signRequest, type HttpSignatureSigner } from './httpSignature.js'
import { validateGraphqlZcap, type GraphqlZcapValidationOptions } from './validate.js'
import {
  CapabilityExpiredError,
  GraphQLTransportError,
  InvocationHeaderTooLargeError,
  RequestTimeoutError,
} from './errors.js'

export interface PreparedRequest {
  method: 'POST'
  /**
   * Spread these into your request rather than reading individual keys.
   * Deliberately not typed with literal header names: which headers this
   * library sends is its own business and has changed once already, so
   * pinning the names here would make the next change break callers at
   * compile time for no benefit.
   */
  headers: Record<string, string>
  body: string
}

/** Size of the largest header this request carries — for diagnostics only. */
function headerBytesOf(prepared: PreparedRequest): number {
  return Math.max(0, ...Object.values(prepared.headers).map((value) => value.length))
}

/**
 * Default ceiling for the built header. Deployed hosts have been measured
 * cutting off between 8KB and 16KB, so 8KB is the conservative floor of
 * that range rather than a spec value.
 */
export const DEFAULT_MAX_HEADER_BYTES = 8192

function assertHeaderFits(header: string, capability: Capability, maxHeaderBytes: number): string {
  if (maxHeaderBytes <= 0) return header
  // Header size is counted in bytes on the wire, not UTF-16 code units.
  // The value is base64url + ASCII punctuation, so the two agree here —
  // measured explicitly anyway so this stays correct if that changes.
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(header).length : header.length
  if (bytes > maxHeaderBytes) {
    throw new InvocationHeaderTooLargeError(bytes, maxHeaderBytes, capability.allowedAction?.length ?? 0)
  }
  return header
}

/**
 * Pure function: (chain, query) -> wire-ready request pieces, with NO
 * invocation — a structural/expiry-only check the resource server can
 * evaluate without a signature. Used by `checkAuth()`'s dev diagnostic
 * always, and by `query()` when `unsafeMode` is on (dev/test only —
 * see `DidGraphQLClientOptions.unsafeMode`).
 */
export function prepareDiagnosticRequest(
  capability: Capability,
  request: GraphQLRequest,
  maxHeaderBytes: number = DEFAULT_MAX_HEADER_BYTES,
): PreparedRequest {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'capability-invocation': assertHeaderFits(
        encodeCapabilityInvocation({ capability }),
        capability,
        maxHeaderBytes,
      ),
    },
    body: JSON.stringify(request),
  }
}

/**
 * Pure function: (invocation, chain, query) -> wire-ready request
 * pieces, for an already-signed invocation. No `fetch` call, no I/O —
 * for callers with their own HTTP stack who just need the right
 * headers/body shape. `DidGraphQLClient.query()` is built on top of
 * this same function.
 */
export function prepareInvokedRequest(
  invocation: SignedInvocation,
  chain: Capability[],
  request: GraphQLRequest,
  maxHeaderBytes: number = DEFAULT_MAX_HEADER_BYTES,
): PreparedRequest {
  // `chain` stays in the signature for source compatibility, but only
  // the leaf is sent: it was always exactly `[capability]`, and the
  // spec's HTTP binding carries one `capability` parameter, not an
  // array. The root is reconstructed by the verifier either way.
  const capability = chain[0]
  if (!capability) throw new Error('prepareInvokedRequest requires at least the leaf capability')
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'capability-invocation': assertHeaderFits(
        encodeCapabilityInvocation({ capability, invocation }),
        capability,
        maxHeaderBytes,
      ),
    },
    body: JSON.stringify(request),
  }
}

export interface DidGraphQLClientOptions {
  /**
   * GraphQL URL to POST. Defaults to `capability.invocationTarget`.
   * If set, it MUST canonicalize to the same URL — this client will not
   * send a ZCAP to a different host than the capability authorizes.
   */
  endpoint?: string
  /** The delegated capability to invoke (`artifacts.zcap.graphql`) — this package never signs, so no key material is ever passed here. */
  capability: Capability
  /**
   * Independent pin for `invocationTarget` — typically the workflow
   * template's `catalog.zcap.graphql.invocationTarget`. If set, the
   * capability MUST name this same GraphQL endpoint.
   */
  expectedInvocationTarget?: string
  /**
   * Hostname allowlist (`api.example.com` or `*.example.org`).
   * If set, `invocationTarget` MUST match an entry.
   */
  allowedHosts?: string[]
  /**
   * Signs a capabilityInvocation for `capability` — supplied by the
   * caller, backed by whatever key store holds the capability
   * controller's key. Required for `query()`; `checkAuth()` doesn't
   * need it (no invocation, diagnostic only).
   */
  invokeCapability?: InvokeCapabilityFn
  /** Custom fetch implementation (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch
  /**
   * Refuse to send a request when the capability is already expired,
   * rather than let the server reject it. Defaults to true.
   */
  checkExpiryBeforeSend?: boolean
  /**
   * Refuse a non-`https://` endpoint. The capability travels as a
   * plain request header — over plaintext HTTP it's exposed to
   * on-path interception and replay just as badly as a bearer token
   * would be. Defaults to false (i.e. HTTPS is required); set true
   * only for local dev against a trusted host.
   */
  allowInsecureEndpoint?: boolean
  /**
   * Sign invocations with RFC 9421 HTTP Message Signatures — the ZCAP
   * spec's own proof mechanism. When set, `query()` uses it instead of
   * `invokeCapability`, and the request carries `Content-Digest`,
   * `Signature-Input` and `Signature` rather than an `invocation`
   * parameter on the capability header.
   *
   * Prefer this. `invokeCapability` remains supported so existing
   * signers can migrate on their own schedule, but it binds only the
   * target URL and the query text, where this binds the whole request.
   */
  httpSignature?: HttpSignatureSigner
  /** Per-request timeout in ms. Defaults to 10_000. Set 0 to disable. */
  timeoutMs?: number
  /**
   * Refuse to send a `Capability-Invocation` header larger than this,
   * throwing `InvocationHeaderTooLargeError` before any HTTP. Defaults
   * to `DEFAULT_MAX_HEADER_BYTES` (8192). Set 0 to disable.
   *
   * The point is the error message, not the limit: over-sized headers
   * are rejected by proxies with statuses ranging from a correct 431 to
   * a bare 400, and the bare 400 reads like a query problem. Failing
   * locally names the real cause.
   */
  maxHeaderBytes?: number
  /**
   * DEV/TEST ONLY — default false. Skips `invokeCapability` entirely:
   * `query()` sends the bare chain with no signed invocation, the same
   * shape `checkAuth()` already uses. Lets the whole client→server
   * wire format be exercised with nothing available to sign with —
   * the server must be configured with its own matching unsafe mode
   * to accept this (its `UNSAFE_MODE`), since a real server's
   * `allowedAction` gate still runs either way. Never set
   * this from a value that isn't a build-time constant you control —
   * it silently drops the one thing that proves the request came from
   * the capability's real controller.
   */
  unsafeMode?: boolean
}

/** AbortSignal that fires whichever of two signals aborts first (caller's + our own timeout). */
function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b
  if (!b) return a
  const controller = new AbortController()
  const onAbort = (signal: AbortSignal) => controller.abort(signal.reason)
  a.addEventListener('abort', () => onAbort(a), { once: true })
  b.addEventListener('abort', () => onAbort(b), { once: true })
  if (a.aborted) controller.abort(a.reason)
  if (b.aborted) controller.abort(b.reason)
  return controller.signal
}

/**
 * A GraphQL client that authorizes every request with a ZCAP-LD
 * capabilityInvocation, matching the `graphql:query` workflow-action
 * design: one delegated capability, invoked (signed) fresh per query
 * via an injected `invokeCapability` function, with the server
 * enforcing `allowedAction` membership and expiry.
 *
 * This package holds no signing keys and does no cryptography —
 * `invokeCapability` is always the caller's own agent, over whatever
 * transport it already uses (see README). Security defaults here are
 * everything that doesn't require a key: the GraphQL ZCAP validation
 * algorithm (`validateGraphqlZcap`), HTTPS-only endpoints, expiry
 * pre-flight, no redirect-following, and a bounded request timeout.
 */
export class DidGraphQLClient {
  private endpoint: string
  private capability: Capability
  private invokeCapability: InvokeCapabilityFn | undefined
  private fetchImpl: typeof fetch
  private httpSignature?: HttpSignatureSigner
  private checkExpiryBeforeSend: boolean
  private timeoutMs: number
  private maxHeaderBytes: number
  private unsafeMode: boolean
  private zcapValidation: GraphqlZcapValidationOptions

  constructor(options: DidGraphQLClientOptions) {
    this.httpSignature = options.httpSignature
    this.checkExpiryBeforeSend = options.checkExpiryBeforeSend ?? true
    this.zcapValidation = {
      allowInsecureEndpoint: options.allowInsecureEndpoint,
      expectedInvocationTarget: options.expectedInvocationTarget,
      allowedHosts: options.allowedHosts,
      checkExpiry: this.checkExpiryBeforeSend,
    }
    const validated = validateGraphqlZcap(options.capability, {
      ...this.zcapValidation,
      fetchEndpoint: options.endpoint,
    })

    this.endpoint = validated.invocationTarget
    this.capability = options.capability
    this.invokeCapability = options.invokeCapability
    // fetch is spec'd to require its receiver be the global object
    // (window/globalThis) — storing the bare function reference and
    // calling it later as `this.fetchImpl(...)` invokes it with `this`
    // bound to the DidGraphQLClient instance instead, which browsers
    // reject outright: "'fetch' called on an object that does not
    // implement interface Window." bind(globalThis) fixes the
    // receiver without needing `window` specifically (also correct in
    // Node/React Native, which have no `window`).
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES
    this.unsafeMode = options.unsafeMode ?? false

    if (this.unsafeMode) {
      // eslint-disable-next-line no-console
      console.warn(
        '[did-graphql-client] unsafeMode is ON — queries send an unsigned capability chain, ' +
          'no invocation is signed. Never enable this against production data.',
      )
    }
  }

  /** Swap in a freshly re-delegated capability without building a new client. */
  setCapability(capability: Capability): void {
    const validated = validateGraphqlZcap(capability, this.zcapValidation)
    this.capability = capability
    this.endpoint = validated.invocationTarget
  }

  private async fetchJson<T>(prepared: PreparedRequest, signal: AbortSignal | undefined): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let timeoutController: AbortController | undefined
    let combined = signal

    if (this.timeoutMs > 0) {
      timeoutController = new AbortController()
      timeoutHandle = setTimeout(() => timeoutController!.abort(new RequestTimeoutError(this.timeoutMs)), this.timeoutMs)
      combined = combineSignals(signal, timeoutController.signal)
    }

    try {
      const res = await this.fetchImpl(this.endpoint, { ...prepared, signal: combined, redirect: 'error' })
      if (!res.ok) {
        if (res.status === 431) {
          // 431 is unambiguous; a bare 400 from a proxy is not, and is
          // the same cause often enough to be worth naming here.
          throw new GraphQLTransportError(
            res.status,
            `${res.statusText} — the capability header (${headerBytesOf(prepared)} bytes) ` +
              'was rejected as too large by the server or a proxy in front of it',
          )
        }
        throw new GraphQLTransportError(res.status, res.statusText)
      }
      return (await res.json()) as T
    } catch (err) {
      if (timeoutController?.signal.aborted && timeoutController.signal.reason instanceof RequestTimeoutError) {
        throw timeoutController.signal.reason
      }
      throw err
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  /**
   * Signs a fresh invocation for `request.query` (via the injected
   * `invokeCapability`) and sends it. `capabilityAction` is the query
   * text itself — this design authorizes by literal query string, so
   * the action being invoked and the allowedAction entry it must
   * match are the same string.
   */
  async query<T = unknown>(request: GraphQLRequest, opts: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    if (this.checkExpiryBeforeSend && isExpired(this.capability)) {
      throw new CapabilityExpiredError(this.capability)
    }

    if (this.unsafeMode) {
      const prepared = prepareDiagnosticRequest(this.capability, request, this.maxHeaderBytes)
      return this.fetchJson<GraphQLResponse<T>>(prepared, opts.signal)
    }

    if (this.httpSignature) {
      // Spec path: the capability header carries only the capability,
      // and the proof is over the HTTP request itself.
      const capabilityInvocation = encodeCapabilityInvocation({ capability: this.capability })
      const body = JSON.stringify(request)
      const signed = await signRequest({
        signer: this.httpSignature,
        method: 'POST',
        endpoint: this.endpoint,
        capabilityInvocation,
        body,
        capability: this.capability,
      })
      const prepared: PreparedRequest = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'capability-invocation': capabilityInvocation,
          ...signed,
        },
        body,
      }
      assertHeaderFits(capabilityInvocation, this.capability, this.maxHeaderBytes)
      return this.fetchJson<GraphQLResponse<T>>(prepared, opts.signal)
    }

    if (!this.invokeCapability) {
      throw new Error(
        'DidGraphQLClient.query() requires httpSignature or invokeCapability — this package does not sign ' +
          'invocations itself; pass a function that calls whatever key store holds the ' +
          "capability controller's key. Or set unsafeMode: true for " +
          'dev/test use against a server configured to accept unsigned requests.',
      )
    }

    // this.endpoint (not capability.invocationTarget) — it's the
    // canonicalized form validateGraphqlZcap already resolved, and the
    // one this.fetchImpl actually POSTs to just below. Signing the raw
    // field here would let the invocation proof vouch for a textually
    // different URL (mismatched case, trailing slash, explicit default
    // port) than the one the request is actually sent to.
    const invocation = await this.invokeCapability(
      this.capability,
      request.query,
      this.endpoint,
    )
    const prepared = prepareInvokedRequest(invocation, [this.capability], request, this.maxHeaderBytes)
    return this.fetchJson<GraphQLResponse<T>>(prepared, opts.signal)
  }

  /**
   * Dev-only diagnostic (`query Auth { auth { zcap { valid } } }`) — reports
   * whether the held capability is structurally valid and unexpired
   * per the resource server. No invocation is signed for this — it's
   * a structural/expiry check on the bare chain, not a real
   * capability use. Not part of the production allowedAction surface.
   * Select more fields on `auth.zcap` (controller, invocationTarget,
   * allowedAction) via `query()` if you need the echo, not just valid.
   */
  async checkAuth(): Promise<boolean> {
    const prepared = prepareDiagnosticRequest(this.capability, { query: AUTH_QUERY }, this.maxHeaderBytes)
    const result = await this.fetchJson<GraphQLResponse<{ auth: { zcap: { valid: boolean } } }>>(prepared, undefined)
    return result.data?.auth?.zcap?.valid ?? false
  }
}
