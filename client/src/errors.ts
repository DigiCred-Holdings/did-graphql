import type { Capability } from './types.js'

export class CapabilityExpiredError extends Error {
  constructor(public readonly capability: Capability) {
    super(`ZCAP capability ${capability.id} expired at ${capability.expires}`)
    this.name = 'CapabilityExpiredError'
  }
}

/** Thrown by `validateCapabilityShape` — cheap, no crypto, structural only. */
export class InvalidCapabilityError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid capability: ${problems.join('; ')}`)
    this.name = 'InvalidCapabilityError'
  }
}

/** Thrown when an endpoint isn't https:// and `allowInsecureEndpoint` wasn't set. */
export class InsecureEndpointError extends Error {
  constructor(public readonly endpoint: string) {
    super(
      `refusing to send a ZCAP invocation to a non-https endpoint (${endpoint}) — ` +
        'the capability travels in a plain request header, so a non-TLS transport ' +
        'exposes it to on-path interception/replay. Pass allowInsecureEndpoint: true ' +
        'only for local dev against a trusted host (e.g. localhost).'
    )
    this.name = 'InsecureEndpointError'
  }
}

/** Thrown when a request is aborted by its own timeout, not by caller cancellation. */
export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`GraphQL request timed out after ${timeoutMs}ms`)
    this.name = 'RequestTimeoutError'
  }
}

/** Thrown when the transport itself failed (non-2xx status, or a non-JSON body). */
export class GraphQLTransportError extends Error {
  constructor(public readonly status: number, public readonly statusText: string) {
    super(`GraphQL transport error: ${status} ${statusText}`)
    this.name = 'GraphQLTransportError'
  }
}

/**
 * Thrown before any HTTP, when the built `Capability-Invocation` header
 * exceeds `maxHeaderBytes`.
 *
 * This exists because the failure it pre-empts is so badly signalled.
 * Hosts cut off between 8KB and 16KB, and not all of them say so: one
 * proxy in use returns a bare `400`, which surfaces as a generic
 * transport error and reads like a malformed query. The cause is almost
 * always `allowedAction` — it is the overwhelming majority of a
 * capability's bytes — so the count is reported alongside the size.
 */
export class InvocationHeaderTooLargeError extends Error {
  constructor(
    public readonly headerBytes: number,
    public readonly maxHeaderBytes: number,
    public readonly allowedActionCount: number,
  ) {
    super(
      `Capability-Invocation header is ${headerBytes} bytes, over the ${maxHeaderBytes}-byte limit ` +
        `for this client. The capability grants ${allowedActionCount} allowedAction ` +
        `${allowedActionCount === 1 ? 'entry' : 'entries'}, which dominate its size. ` +
        'Delegate fewer queries, or register wider documents and rely on field-subset matching. ' +
        'Raise maxHeaderBytes only if the server and every proxy in front of it accept larger headers.',
    )
    this.name = 'InvocationHeaderTooLargeError'
  }
}
