// The field-subset matcher compares root fields and their nested field
// names. It did not compare the OPERATION TYPE, so a capability granting
// a query authorized the same-named mutation — a read grant permitting a
// write, wherever a schema exposes the same name on Query and Mutation.
//
// The exact-match path never had this problem: the operation keyword is
// part of the document text it compares. Only the subset fallback did.

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

test('a query grant does NOT authorize the same-named mutation', () => {
  const capability = grants(['query Thing { thing { a b } }'])

  assert.equal(allows(capability, 'query Thing { thing { a } }'), true, 'narrower query should still pass')
  assert.equal(
    allows(capability, 'mutation Thing { thing { a } }'),
    false,
    'a read capability must not authorize a write',
  )
  assert.equal(allows(capability, 'mutation Thing { thing { a b } }'), false)
})

test('a mutation grant does not authorize the same-named query either', () => {
  // Symmetric, and the one that matters less but should still hold:
  // the grant says what it says.
  const capability = grants(['mutation Thing { thing { a b } }'])
  assert.equal(allows(capability, 'mutation Thing { thing { a } }'), true)
  assert.equal(allows(capability, 'query Thing { thing { a } }'), false)
})

test('mutations still attenuate by field subset among themselves', () => {
  // The fix must not disable subset matching for mutations — narrowing
  // a granted mutation is still legitimate.
  const capability = grants(['mutation Register { registerThing { id status detail } }'])
  assert.equal(allows(capability, 'mutation Register { registerThing { id } }'), true)
  assert.equal(allows(capability, 'mutation Register { registerThing { id secret } }'), false)
})

test('an anonymous operation is a query, per GraphQL defaults', () => {
  const capability = grants(['query Thing { thing { a b } }'])
  assert.equal(allows(capability, '{ thing { a } }'), true)

  const mutationCapability = grants(['mutation Thing { thing { a b } }'])
  assert.equal(allows(mutationCapability, '{ thing { a } }'), false)
})

test('exact match is unaffected — it always compared the keyword', () => {
  const capability = grants(['query Thing { thing { a b } }'])
  assert.equal(allows(capability, 'query Thing { thing { a b } }'), true)
  assert.equal(allows(capability, 'query   Thing {  thing {  a b }  }'), true, 'whitespace-normalized')
})
