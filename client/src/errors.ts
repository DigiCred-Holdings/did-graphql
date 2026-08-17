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
