import './helpers/askarSetup.js'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Agent } from '@credo-ts/core'

import { checkAuthOnly, checkInvocation, configureZcap, type RealZcapServerConfig } from '../server/src/zcap.js'
import { AUTH_QUERY, GRAPHQL_ENDPOINT, delegateGraphqlZcap, invokeGraphqlZcap, materializeRoot } from './helpers/zcapFixtures.js'
import { createDidKey, createTestAgent, type DidKeyPair } from './helpers/credoAgent.js'

let agent: Agent
let issuer: DidKeyPair
let holder: DidKeyPair

before(async () => {
  agent = await createTestAgent()
  issuer = await createDidKey(agent)
  holder = await createDidKey(agent)
})

after(async () => {
  if (agent) await agent.shutdown()
})

function realConfig(rootController = issuer.did, expectedInvocationTarget = GRAPHQL_ENDPOINT): RealZcapServerConfig {
  return configureZcap({
    rootCapability: materializeRoot(rootController, expectedInvocationTarget),
    expectedInvocationTarget,
  }) as RealZcapServerConfig
}

test('configureZcap accepts a real (non-unsafe) config with a rootCapability', () => {
  const config = configureZcap({ rootCapability: materializeRoot(issuer.did), expectedInvocationTarget: GRAPHQL_ENDPOINT })
  assert.equal(config.unsafeMode, undefined)
})

test('checkAuthOnly verifies a did:key chain locally, no agent or DB involved', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const result = checkAuthOnly(realConfig(), { chain: [capability] })
  assert.equal(result.valid, true, result.reason ?? '')
  assert.equal(result.controller, holder.did)
  assert.deepEqual(result.problems, [])
})

test('checkAuthOnly rejects a tampered did:key leaf, with a PROOF_INVALID problem', () => {
  const tampered = { id: 'urn:zcap:delegated:tampered', controller: holder.did, invocationTarget: GRAPHQL_ENDPOINT, allowedAction: ['query Evil { x }'] }
  const result = checkAuthOnly(realConfig(), { chain: [tampered as never] })
  assert.equal(result.valid, false)
  assert.ok(result.problems.length > 0)
})

test('checkAuthOnly rejects a rootCapability whose controller did not sign the leaf (PROOF_INVALID)', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  // Same invocationTarget, so parentCapability still matches (root id is
  // derived from invocationTarget alone) — but the leaf's delegation
  // proof was signed by `issuer`, not by this (wrong) trusted controller.
  const result = checkAuthOnly(realConfig(holder.did), { chain: [capability] })
  assert.equal(result.valid, false)
  assert.ok(result.problems.some((p) => p.typeURI.endsWith(':PROOF_INVALID')))
})

test('checkAuthOnly rejects an invocationTarget that does not match the request (INVOCATION_TARGET_MISMATCH)', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const result = checkAuthOnly(realConfig(issuer.did, 'https://other.example.edu/graphql'), { chain: [capability] })
  assert.equal(result.valid, false)
  assert.ok(result.problems.some((p) => p.typeURI.endsWith(':INVOCATION_TARGET_MISMATCH')))
})

test('checkAuthOnly refuses a non-did:key root controller (UNSUPPORTED_CONTROLLER)', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const result = checkAuthOnly(realConfig('did:web:catalog.example.edu'), { chain: [capability] })
  assert.equal(result.valid, false)
  assert.ok(result.problems.some((p) => p.typeURI.endsWith(':UNSUPPORTED_CONTROLLER')))
})

test('checkInvocation verifies a did:key invocation locally with no agent', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const invocation = await invokeGraphqlZcap(agent, holder, capability, AUTH_QUERY, GRAPHQL_ENDPOINT)
  const gate = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)
  assert.equal(gate.ok, true, gate.message)
})

test('checkInvocation rejects a query not in allowedAction before requiring an invocation (ACTION_NOT_ALLOWED)', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const gate = checkInvocation(realConfig(), { chain: [capability] }, 'query { colleges { items { name } } }')
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'QUERY_NOT_ALLOWED')
})

test('checkInvocation rejects a missing invocation on an otherwise valid did:key chain (INVOCATION_MISSING)', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const gate = checkInvocation(realConfig(), { chain: [capability] }, AUTH_QUERY)
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'INVOCATION_INVALID')
  assert.ok(gate.problems?.some((p) => p.typeURI.endsWith(':INVOCATION_MISSING')))
})

test('checkInvocation rejects an invocation signed by someone other than the leaf controller', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  // Signed by the issuer (root controller), not the holder (leaf controller) — invalid invoker.
  const invocation = await invokeGraphqlZcap(agent, issuer, capability, AUTH_QUERY, GRAPHQL_ENDPOINT)
  const gate = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'INVOCATION_INVALID')
})
