// A GraphQL document can hold several operations; the host executes
// the one named by `operationName`. The allowedAction matcher only
// inspected the FIRST operation and never saw `operationName`, so
// `query A {...} query B {...}` with `operationName: "B"` ran B under a
// capability granting only A. The embedded invocation proof signs the
// document, not `operationName`, so a legitimate holder could do this
// with a perfectly valid signature.
//
// Fixed by requiring every operation in the document to be allowed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkInvocation, configureZcap } from '../server/src/zcap.js'
import type { Capability } from '../client/src/types.js'
import { GRAPHQL_ENDPOINT } from './helpers/zcapFixtures.js'

const config = configureZcap({
  unsafeMode: true,
  trust: { trustedRootController: 'did:key:z6Mkplaceholder', expectedInvocationTarget: GRAPHQL_ENDPOINT },
})

function grants(allowedAction: string[]): Capability {
  return {
    id: 'urn:zcap:test',
    controller: 'did:key:z6Mkinvoker',
    invocationTarget: GRAPHQL_ENDPOINT,
    allowedAction,
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    proof: { type: 'DataIntegrityProof', verificationMethod: 'did:key:z6Mkissuer#z6Mkissuer' },
  }
}

function allows(capability: Capability, query: string): boolean {
  return checkInvocation(config, { chain: [capability] }, query).ok
}

const A = 'query A { catalog { colleges { name } } }'
const B = 'query B { catalog { item(id: "x") { name } } }'
const C = 'query C { case { cfDocuments { title } } }'

test('an ungranted operation after a granted one is rejected', () => {
  const capability = grants([A])
  assert.equal(allows(capability, A), true)
  assert.equal(allows(capability, B), false)
  assert.equal(allows(capability, `${A}\n${B}`), false, 'B must not ride along behind A')
  assert.equal(allows(capability, `${A}\n${C}`), false, 'nor a different root field')
})

test('an ungranted operation before a granted one is rejected', () => {
  const capability = grants([A])
  assert.equal(allows(capability, `${B}\n${A}`), false)
})

test('a ride-along mutation is rejected behind a granted query', () => {
  const capability = grants(['query Thing { thing { a b } }'])
  assert.equal(allows(capability, 'query Thing { thing { a } }\nmutation Steal { thing { a } }'), false)
})

test('a multi-operation document passes when every operation is granted', () => {
  const capability = grants([A, B])
  assert.equal(allows(capability, `${A}\n${B}`), true)
  // Narrower selections of each granted operation still attenuate.
  assert.equal(allows(capability, 'query A { catalog { colleges { name } } }\nquery B2 { catalog { item(id: "y") { name } } }'), true)
})

test('a granted multi-operation entry grants each of its operations', () => {
  // Already true via exact match for the whole document; the subset
  // path must agree for each operation on its own.
  const capability = grants([`${A}\n${B}`])
  assert.equal(allows(capability, `${A}\n${B}`), true)
  assert.equal(allows(capability, B), true)
  assert.equal(allows(capability, C), false)
})

test('an unparseable trailing operation fails closed', () => {
  const capability = grants([A])
  assert.equal(allows(capability, `${A}\nquery D { ...Spread }\nfragment Spread on Query { case { cfDocuments { title } } }`), false)
})
