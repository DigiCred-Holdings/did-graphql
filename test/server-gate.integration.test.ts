import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkAuthOnly, configureZcap, decodeInvocationHeader } from '../server/src/zcap.js'
import { encodeInvocationHeader } from '../client/src/zcap.js'
import type { Capability } from '../client/src/types.js'
import { AUTH_QUERY, GRAPHQL_ENDPOINT } from './helpers/zcapFixtures.js'

const unsafeConfig = configureZcap({
  unsafeMode: true,
  trust: { trustedRootController: 'did:key:z6Mkplaceholder', expectedInvocationTarget: GRAPHQL_ENDPOINT },
})

function unsignedLeaf(overrides: Partial<Capability> = {}): Capability {
  return {
    id: 'urn:zcap:test',
    controller: 'did:key:z6Mkholder',
    invocationTarget: GRAPHQL_ENDPOINT,
    allowedAction: [AUTH_QUERY],
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    proof: { type: 'DataIntegrityProof', verificationMethod: 'did:key:z6Mkissuer#z6Mkissuer' },
    ...overrides,
  }
}

test('unsafe checkAuthOnly accepts a structurally valid chain (query Auth { zcap { valid } })', async () => {
  const header = encodeInvocationHeader({ chain: [unsignedLeaf()] })
  const result = await checkAuthOnly(unsafeConfig, decodeInvocationHeader(header))
  assert.equal(result.valid, true)
  assert.equal(result.reason, null)
  assert.equal(result.controller, 'did:key:z6Mkholder')
  assert.equal(result.invocationTarget, GRAPHQL_ENDPOINT)
  assert.deepEqual(result.allowedAction, [AUTH_QUERY])
})

test('unsafe checkAuthOnly rejects a missing chain', async () => {
  const result = await checkAuthOnly(unsafeConfig, { chain: [] })
  assert.equal(result.valid, false)
})

test('unsafe checkAuthOnly rejects invocationTarget mismatch', async () => {
  const leaf = unsignedLeaf({ invocationTarget: 'https://other.example/graphql' })
  const result = await checkAuthOnly(unsafeConfig, decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf] })))
  assert.equal(result.valid, false)
  assert.match(result.reason ?? '', /invocationTarget mismatch/)
})
