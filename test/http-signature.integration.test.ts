// The RFC 9421 path against a REAL verified chain, with the invocation
// signed by the capability's actual controller key via Credo's KMS —
// which is also how the wallet will sign it.

import './helpers/askarSetup.js'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Agent } from '@credo-ts/core'

import { signRequest, type HttpSignatureSigner } from '../client/src/httpSignature.js'
import { encodeCapabilityInvocation } from '../client/src/zcap.js'
import { checkInvocation, configureZcap, type RealZcapServerConfig } from '../server/src/zcap.js'
import { createDidKey, createTestAgent, type DidKeyPair } from './helpers/credoAgent.js'
import { AUTH_QUERY, GRAPHQL_ENDPOINT, delegateGraphqlZcap, materializeRoot } from './helpers/zcapFixtures.js'

let agent: Agent
let issuer: DidKeyPair
let invoker: DidKeyPair

before(async () => {
  agent = await createTestAgent()
  issuer = await createDidKey(agent)
  invoker = await createDidKey(agent)
})

after(async () => {
  if (agent) await agent.shutdown()
})

/** Exactly the shape the wallet will implement. */
function credoSigner(keyPair: DidKeyPair): HttpSignatureSigner {
  return {
    keyid: keyPair.verificationMethod,
    async sign(base) {
      const result = await agent.kms.sign({
        keyId: keyPair.keyId,
        algorithm: 'EdDSA',
        data: Buffer.from(base, 'utf8'),
      })
      const sig = (result as { signature?: Uint8Array }).signature ?? (result as unknown as Uint8Array)
      return sig instanceof Uint8Array ? sig : new Uint8Array(sig)
    },
  }
}

function realConfig(overrides: Partial<RealZcapServerConfig> = {}): RealZcapServerConfig {
  return configureZcap({
    rootCapability: materializeRoot(issuer.did, GRAPHQL_ENDPOINT),
    expectedInvocationTarget: GRAPHQL_ENDPOINT,
    ...overrides,
  }) as RealZcapServerConfig
}

async function signedRequest(created?: number) {
  const capability = await delegateGraphqlZcap(agent, issuer, invoker)
  const capabilityInvocation = encodeCapabilityInvocation({ capability })
  const body = JSON.stringify({ query: AUTH_QUERY })
  const headers = await signRequest({
    signer: credoSigner(invoker),
    method: 'POST',
    endpoint: GRAPHQL_ENDPOINT,
    capabilityInvocation,
    body,
    created,
  })
  return {
    capability,
    httpRequest: {
      method: 'POST',
      url: GRAPHQL_ENDPOINT,
      capabilityInvocation,
      contentType: 'application/json',
      contentDigest: headers['content-digest'],
      signatureInput: headers['signature-input'],
      signature: headers.signature,
      body,
    },
  }
}

test('a real chain with an RFC 9421 proof passes the full gate', async () => {
  const { capability, httpRequest } = await signedRequest()
  const result = checkInvocation(realConfig(), { chain: [capability] }, AUTH_QUERY, httpRequest)
  assert.equal(result.ok, true, result.message)
})

test('no embedded invocation is needed — the HTTP signature is the proof', async () => {
  const { capability, httpRequest } = await signedRequest()
  // `invocation` is absent from the payload entirely; before this, that
  // would have failed with INVOCATION_MISSING.
  const result = checkInvocation(realConfig(), { chain: [capability], invocation: undefined }, AUTH_QUERY, httpRequest)
  assert.equal(result.ok, true, result.message)
})

test('the configured freshness window applies to the signature path too', async () => {
  const { capability, httpRequest } = await signedRequest(Math.floor(Date.now() / 1000) - 3600)
  const result = checkInvocation(realConfig(), { chain: [capability] }, AUTH_QUERY, httpRequest)
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /freshness window/)
})

test('a signature over a different body is rejected against a real chain', async () => {
  const { capability, httpRequest } = await signedRequest()
  const tampered = { ...httpRequest, body: JSON.stringify({ query: 'query Evil { x }' }) }
  const result = checkInvocation(realConfig(), { chain: [capability] }, AUTH_QUERY, tampered)
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /Content-Digest/)
})

test('allowedAction is still enforced — a valid signature does not bypass it', async () => {
  // The signature proves who sent the request, not what they may ask for.
  const { capability, httpRequest } = await signedRequest()
  const result = checkInvocation(realConfig(), { chain: [capability] }, 'query Other { nope }', httpRequest)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'QUERY_NOT_ALLOWED')
})

test('the embedded Data Integrity path still works when no signature is present', async () => {
  // The wallet has not migrated yet, so this must keep passing.
  const { invokeGraphqlZcap } = await import('./helpers/zcapFixtures.js')
  const capability = await delegateGraphqlZcap(agent, issuer, invoker)
  const invocation = await invokeGraphqlZcap(agent, invoker, capability, AUTH_QUERY, GRAPHQL_ENDPOINT)
  const result = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)
  assert.equal(result.ok, true, result.message)
})
