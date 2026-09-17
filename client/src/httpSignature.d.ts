import type { Capability } from './types.js';
/** The signature label. `zcap` in the spec's examples. */
export declare const SIGNATURE_LABEL = "zcap";
/**
 * Covered components, in order. Order is part of the signature base, so
 * it is fixed here rather than configurable — a verifier rebuilds the
 * base from `Signature-Input`, so a different order would still verify,
 * but matching the spec's example keeps interop boringly predictable.
 */
export declare const COVERED_COMPONENTS: readonly ["@method", "@path", "capability-invocation", "content-digest", "content-type"];
/**
 * Signs the RFC 9421 signature base. This package never holds keys, so
 * this is supplied by the caller, exactly as `invokeCapability` is.
 *
 * `keyid` must be resolvable *before* signing: it is inside
 * `@signature-params`, which is itself part of what gets signed.
 */
export interface HttpSignatureSigner {
    /** Verification method id — e.g. `did:key:z6Mk…#z6Mk…`. */
    keyid: string | (() => string | Promise<string>);
    /** Ed25519 signature over the signature base, raw (64 bytes). */
    sign(signatureBase: string): Uint8Array | Promise<Uint8Array>;
}
/**
 * `Content-Digest: sha-256=:<base64>:` per RFC 9530.
 *
 * This is what actually binds the request body — the signature covers
 * the digest, not the bytes. Without it, the signature would say nothing
 * about which GraphQL query was sent.
 */
export declare function contentDigest(body: string): string;
/** The `@signature-params` value — also the `Signature-Input` value. */
export declare function signatureParams(keyid: string, created: number): string;
/**
 * Build the RFC 9421 signature base.
 *
 * One line per covered component as `"name": value`, newline-separated,
 * ending with `"@signature-params": <params>` and **no trailing
 * newline**. Both sides must agree byte-for-byte, so this function is
 * shared: the server imports it rather than reimplementing it, which is
 * the only reliable way to keep two implementations of a canonical
 * string in step.
 */
export declare function buildSignatureBase(input: {
    method: string;
    path: string;
    capabilityInvocation: string;
    contentDigest: string;
    contentType: string;
    keyid: string;
    created: number;
}): string;
/** `@path` — the path only, no query string, per RFC 9421. */
export declare function pathOf(endpoint: string): string;
export interface SignedHttpHeaders {
    'content-digest': string;
    'signature-input': string;
    signature: string;
}
/**
 * Produce the three headers that carry an RFC 9421 proof.
 *
 * `capabilityInvocation` is passed in rather than rebuilt, because the
 * signature covers that header's exact bytes — regenerating it here
 * risks signing a value different from the one actually sent (gzip is
 * deterministic for a given input, but this removes the question).
 */
export declare function signRequest(input: {
    signer: HttpSignatureSigner;
    method: string;
    endpoint: string;
    capabilityInvocation: string;
    body: string;
    contentType?: string;
    /** Injectable for tests. Seconds since the epoch, as RFC 9421 uses. */
    created?: number;
    /** Unused today; present so a signer can log or scope by capability. */
    capability?: Capability;
}): Promise<SignedHttpHeaders>;
