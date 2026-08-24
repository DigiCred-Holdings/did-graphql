import './helpers/askarSetup.js'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Agent } from '@credo-ts/core'

import { checkAuthOnly, checkInvocation, configureZcap } from '../server/src/zcap.js'
import { AUTH_QUERY, GRAPHQL_ENDPOINT, delegateGraphqlZcap, invokeGraphqlZcap } from './helpers/zcapFixtures.js'
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

function localConfig() {
  return configureZcap({
    trust: { trustedRootController: issuer.did, expectedInvocationTarget: GRAPHQL_ENDPOINT },
  })
}

test('configureZcap does not require agentConfig (did:key is the default path)', () => {
  const config = localConfig()
  assert.equal(config.agentConfig, undefined)
  assert.equal(config.unsafeMode, undefined)
})

test('checkAuthOnly verifies a did:key chain locally with no agent', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const result = await checkAuthOnly(localConfig(), { chain: [capability] })
  assert.equal(result.valid, true, result.reason ?? '')
  assert.equal(result.controller, holder.did)
})

test('checkAuthOnly rejects a tampered did:key leaf', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const tampered = { ...capability, controller: holder.did, allowedAction: ['query Evil { x }'] }
  const result = await checkAuthOnly(localConfig(), { chain: [tampered] })
  assert.equal(result.valid, false)
  assert.match(result.reason ?? '', /proof verification failed/)
})

test('checkAuthOnly rejects a trustedRootController that did not sign the leaf', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const result = await checkAuthOnly(
    configureZcap({ trust: { trustedRootController: holder.did, expectedInvocationTarget: GRAPHQL_ENDPOINT } }),
    { chain: [capability] },
  )
  assert.equal(result.valid, false)
})

test('checkInvocation verifies a did:key invocation locally with no agent', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const invocation = await invokeGraphqlZcap(agent, holder, capability, AUTH_QUERY, GRAPHQL_ENDPOINT)
  const gate = await checkInvocation(localConfig(), { chain: [capability], invocation }, AUTH_QUERY)
  assert.equal(gate.ok, true, gate.message)
})

test('checkInvocation rejects a query not in allowedAction before checking the invocation', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const gate = await checkInvocation(localConfig(), { chain: [capability] }, 'query { colleges { items { name } } }')
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'QUERY_NOT_ALLOWED')
})

test('checkInvocation rejects a missing invocation on an otherwise valid did:key chain', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const gate = await checkInvocation(localConfig(), { chain: [capability] }, AUTH_QUERY)
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'INVOCATION_INVALID')
})

test('checkAuthOnly refuses a non-did:key controller when no agentConfig is set', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  const result = await checkAuthOnly(
    configureZcap({
      trust: { trustedRootController: 'did:web:catalog.example.edu', expectedInvocationTarget: GRAPHQL_ENDPOINT },
    }),
    { chain: [capability] },
  )
  assert.equal(result.valid, false)
  assert.match(result.reason ?? '', /did:key/)
})
