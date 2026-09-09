import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkIntrospection, containsSchemaIntrospection, configureZcap } from '../server/src/index.js'
import { GRAPHQL_ENDPOINT } from './helpers/zcapFixtures.js'

const unsafeConfig = configureZcap({
  unsafeMode: true,
  trust: { trustedRootController: 'did:key:z6Mkplaceholder', expectedInvocationTarget: GRAPHQL_ENDPOINT },
})

const realConfig = configureZcap({
  rootCapability: {
    id: 'urn:zcap:root:test',
    controller: 'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG',
    invocationTarget: GRAPHQL_ENDPOINT,
    allowedAction: ['query Registered { case { cfDocuments { items { identifier } } } }'],
  },
  expectedInvocationTarget: GRAPHQL_ENDPOINT,
})

const structurallyValidChain = {
  chain: [
    {
      id: 'urn:zcap:test',
      controller: 'did:key:z6Mkinvoker',
      invocationTarget: GRAPHQL_ENDPOINT,
      allowedAction: ['query Registered { case { cfDocuments { items { identifier } } } }'],
      expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      proof: { type: 'DataIntegrityProof', verificationMethod: 'did:key:z6Mkissuer#z6Mkissuer' },
    },
  ],
}

test('containsSchemaIntrospection finds __schema at the root', () => {
  assert.equal(containsSchemaIntrospection('{ __schema { types { name } } }'), true)
})

test('containsSchemaIntrospection finds an aliased __type', () => {
  assert.equal(containsSchemaIntrospection('query Q { t: __type(name: "Zcap") { name } }'), true)
})

test('containsSchemaIntrospection follows inline fragments', () => {
  assert.equal(containsSchemaIntrospection('{ ... on Query { __schema { queryType { name } } } }'), true)
})

test('containsSchemaIntrospection follows a named fragment spread — introspection hidden a hop away', () => {
  assert.equal(
    containsSchemaIntrospection('query Q { ...F } fragment F on Query { __schema { types { name } } }'),
    true,
  )
})

test('containsSchemaIntrospection survives a cyclic fragment without hanging', () => {
  assert.equal(
    containsSchemaIntrospection('query Q { ...A } fragment A on Query { ...B } fragment B on Query { ...A }'),
    false,
  )
})

test('containsSchemaIntrospection ignores __typename and ordinary fields', () => {
  assert.equal(containsSchemaIntrospection('{ __typename }'), false)
  assert.equal(containsSchemaIntrospection('{ case { __typename cfDocuments { items { identifier } } } }'), false)
})

test('containsSchemaIntrospection returns false for an unparseable document', () => {
  assert.equal(containsSchemaIntrospection('{ this is not graphql'), false)
})

test('checkIntrospection passes any non-introspecting document, with no capability', () => {
  const result = checkIntrospection(realConfig, null, 'query Registered { case { cfDocuments { items { identifier } } } }')
  assert.deepEqual(result, { ok: true })
})

test('checkIntrospection refuses introspection with no capability — the bypass this closes', () => {
  const result = checkIntrospection(realConfig, null, '{ __schema { types { name fields { name } } } }')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INTROSPECTION_NOT_ALLOWED')
  assert.match(result.message ?? '', /requires a valid capability/)
})

test('checkIntrospection refuses introspection hidden in a named fragment', () => {
  const result = checkIntrospection(realConfig, null, 'query Q { ...F } fragment F on Query { __schema { types { name } } }')
  assert.equal(result.ok, false)
})

test("checkIntrospection allows introspection for a valid chain, without needing it in allowedAction", () => {
  const result = checkIntrospection(unsafeConfig, structurallyValidChain, '{ __schema { types { name } } }')
  assert.deepEqual(result, { ok: true })
})

test('checkIntrospection policy "off" refuses even a valid chain', () => {
  const result = checkIntrospection(unsafeConfig, structurallyValidChain, '{ __schema { types { name } } }', 'off')
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /disabled/)
})

test('checkIntrospection policy "public" allows introspection with no capability', () => {
  assert.deepEqual(checkIntrospection(realConfig, null, '{ __schema { types { name } } }', 'public'), { ok: true })
})
