import type {
  Capability,
  GraphQLRequest,
  GraphQLResponse,
  InvokeCapabilityFn,
  SignedInvocation,
} from './types.js'
import { encodeInvocationHeader, isExpired } from './zcap.js'
import { validateCapabilityShape } from './validate.js'
import {
  CapabilityExpiredError,
  GraphQLTransportError,
  InsecureEndpointError,
  RequestTimeoutError,
} from './errors.js'

export interface PreparedRequest {
  method: 'POST'
  headers: { 'content-type': 'application/json'; 'x-zcap-invocation': string }
  body: string
}

/**
 * Pure function: (chain, query) -> wire-ready request pieces, with NO
 * invocation — a structural/expiry-only check the resource server can
 * evaluate without a signature. Used by `checkAuth()`'s dev diagnostic
 * always, and by `query()` when `unsafeMode` is on (dev/test only —
 * see `DidGraphQLClientOptions.unsafeMode`).
 */
export function prepareDiagnosticRequest(capability: Capability, request: GraphQLRequest): PreparedRequest {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zcap-invocation': encodeInvocationHeader({ chain: [capability] }),
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
): PreparedRequest {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zcap-invocation': encodeInvocationHeader({ invocation, chain }),
    },
    body: JSON.stringify(request),
  }
}

export interface DidGraphQLClientOptions {
  /** The GraphQL endpoint — `catalog.zcap.graphql.invocationTarget`. */
  endpoint: string
  /** The delegated capability to invoke (`artifacts.zcap.graphql`) — this package never signs, so no key material is ever passed here. */
  capability: Capability
  /**
   * Signs a capabilityInvocation for `capability` — call whatever
   * agent holds the capability controller's key (e.g. companion-app's
   * own agent via `POST /w3c-vc/zcaps/invoke`). Required for `query()`;
   * `checkAuth()` doesn't need it (no invocation, diagnostic only).
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
  /** Per-request timeout in ms. Defaults to 10_000. Set 0 to disable. */
  timeoutMs?: number
  /**
   * DEV/TEST ONLY — default false. Skips `invokeCapability` entirely:
   * `query()` sends the bare chain with no signed invocation, the same
   * shape `checkAuth()` already uses. Lets the whole client→server
   * wire format be exercised without a live agent to sign anything —
   * the server must be configured with its own matching unsafe mode
   * to accept this (see catalog-graphql's UNSAFE_MODE), since a real
   * server's `allowedAction` gate still runs either way. Never set
   * this from a value that isn't a build-time constant you control —
   * it silently drops the one thing that proves the request came from
   * a real capability holder.
   */
  unsafeMode?: boolean
}

function assertSecureEndpoint(endpoint: string, allowInsecure: boolean | undefined): void {
  if (allowInsecure) return
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new InsecureEndpointError(endpoint)
  }
  if (url.protocol !== 'https:') throw new InsecureEndpointError(endpoint)
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
 * everything that doesn't require a key: HTTPS-only endpoints,
 * structural capability validation, client-side expiry pre-flight,
 * and a bounded request timeout.
 */
export class DidGraphQLClient {
  private endpoint: string
  private capability: Capability
  private invokeCapability: InvokeCapabilityFn | undefined
  private fetchImpl: typeof fetch
  private checkExpiryBeforeSend: boolean
  private timeoutMs: number
  private unsafeMode: boolean

  constructor(options: DidGraphQLClientOptions) {
    assertSecureEndpoint(options.endpoint, options.allowInsecureEndpoint)
    validateCapabilityShape(options.capability)

    this.endpoint = options.endpoint
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
    this.checkExpiryBeforeSend = options.checkExpiryBeforeSend ?? true
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.unsafeMode = options.unsafeMode ?? false

    if (this.unsafeMode) {
      // eslint-disable-next-line no-console
      console.warn(
        '[did-graphql] unsafeMode is ON — queries send an unsigned capability chain, ' +
          'no invocation is signed. Never enable this against production data.',
      )
    }
  }

  /** Swap in a freshly re-delegated capability without building a new client. */
  setCapability(capability: Capability): void {
    validateCapabilityShape(capability)
    this.capability = capability
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
      const res = await this.fetchImpl(this.endpoint, { ...prepared, signal: combined })
      if (!res.ok) throw new GraphQLTransportError(res.status, res.statusText)
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
      const prepared = prepareDiagnosticRequest(this.capability, request)
      return this.fetchJson<GraphQLResponse<T>>(prepared, opts.signal)
    }

    if (!this.invokeCapability) {
      throw new Error(
        'DidGraphQLClient.query() requires invokeCapability — this package does not sign ' +
          'invocations itself; pass a function that calls whatever agent holds the capability ' +
          "controller's key (e.g. POST /w3c-vc/zcaps/invoke). Or set unsafeMode: true for " +
          'dev/test use against a server configured to accept unsigned requests.',
      )
    }

    const invocation = await this.invokeCapability(this.capability, request.query, this.endpoint)
    const prepared = prepareInvokedRequest(invocation, [this.capability], request)
    return this.fetchJson<GraphQLResponse<T>>(prepared, opts.signal)
  }

  /**
   * Dev-only diagnostic (`query Auth { zcap }`) — reports whether the
   * held capability is structurally valid and unexpired per the
   * resource server. No invocation is signed for this — it's a
   * structural/expiry check on the bare chain, not a real capability
   * use. Not part of the production allowedAction surface; see the
   * catalog-graphql-mock README.
   */
  async checkAuth(): Promise<boolean> {
    const prepared = prepareDiagnosticRequest(this.capability, { query: 'query Auth { zcap }' })
    const result = await this.fetchJson<GraphQLResponse<{ zcap: boolean }>>(prepared, undefined)
    return result.data?.zcap ?? false
  }
}
