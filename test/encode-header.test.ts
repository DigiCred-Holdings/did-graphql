import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decodeInvocationHeader, encodeInvocationHeader } from '../client/src/zcap.js'
import type { Capability, SignedInvocation } from '../client/src/types.js'

const leaf: Capability = {
  id: 'urn:zcap:delegated:test',
  controller: 'did:key:z6MkReceiver',
  invocationTarget: 'https://catalog.example.edu/graphql',
  allowedAction: [
    'query Colleges { colleges { items { name } } }',
    'query Programs { programs { items { name } } }',
  ],
  expires: '2099-01-01T00:00:00Z',
  proof: { type: 'DataIntegrityProof', verificationMethod: 'did:key:z6MkIssuer#z6MkIssuer' },
}

function invocation(id: string): SignedInvocation {
  return {
    id,
    proof: {
      type: 'DataIntegrityProof',
      verificationMethod: 'did:key:z6MkReceiver#z6MkReceiver',
      proofPurpose: 'capabilityInvocation',
      capability: leaf.id,
      capabilityAction: 'query Colleges { colleges { items { name } } }',
      invocationTarget: leaf.invocationTarget,
    },
  }
}

test('invoked header round-trips and matches JSON.stringify of the payload', () => {
  const payload = { chain: [leaf], invocation: invocation('urn:inv:1') }
  const decoded = decodeInvocationHeader(encodeInvocationHeader(payload))
  assert.deepEqual(decoded, JSON.parse(JSON.stringify(payload)))
})

test('reuses leaf JSON across invocations — decoded chain is the same object graph', () => {
  const first = decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf], invocation: invocation('urn:inv:1') }))
  const second = decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf], invocation: invocation('urn:inv:2') }))
  assert.deepEqual(first.chain, second.chain)
  assert.equal(first.invocation?.id, 'urn:inv:1')
  assert.equal(second.invocation?.id, 'urn:inv:2')
})

test('diagnostic header is stable for the same leaf', () => {
  const a = encodeInvocationHeader({ chain: [leaf] })
  const b = encodeInvocationHeader({ chain: [leaf] })
  assert.equal(a, b)
  assert.equal(decodeInvocationHeader(a).invocation, undefined)
  assert.deepEqual(decodeInvocationHeader(a).chain[0], JSON.parse(JSON.stringify(leaf)))
})
