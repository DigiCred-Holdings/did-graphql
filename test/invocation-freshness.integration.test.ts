// An invocation binds its target URL and its exact query text, so a
// captured header cannot be redirected or reused for a different query.
// What it did not bind, until now, was *time*: the only deadline was the
// capability's `expires`, typically months out, so a captured header
// stayed replayable for that one query for months.
//
// These tests sign with a back-dated `created` rather than editing one
// after signing — `created` is inside the signed proof options, so
// editing it would break the signature and the test would pass for the
// wrong reason.

import './helpers/askarSetup.js'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Agent } from '@credo-ts/core'

import { checkInvocation, configureZcap, type RealZcapServerConfig } from '../server/src/zcap.js'
import {
  DEFAULT_INVOCATION_CLOCK_SKEW_SECONDS,
  DEFAULT_INVOCATION_MAX_AGE_SECONDS,
} from '../server/src/localVerify.js'
import { createDidKey, createTestAgent, type DidKeyPair } from './helpers/credoAgent.js'
import {
  AUTH_QUERY,
  GRAPHQL_ENDPOINT,
  delegateGraphqlZcap,
  invokeGraphqlZcap,
  materializeRoot,
} from './helpers/zcapFixtures.js'

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

function realConfig(overrides: Partial<RealZcapServerConfig> = {}): RealZcapServerConfig {
  return configureZcap({
    rootCapability: materializeRoot(issuer.did, GRAPHQL_ENDPOINT),
    expectedInvocationTarget: GRAPHQL_ENDPOINT,
    ...overrides,
  }) as RealZcapServerConfig
}

function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function invocationCreatedAt(created: string) {
  const capability = await delegateGraphqlZcap(agent, issuer, invoker)
  const invocation = await invokeGraphqlZcap(
    agent,
    invoker,
    capability,
    AUTH_QUERY,
    GRAPHQL_ENDPOINT,
    created,
  )
  return { capability, invocation }
}

test('a fresh invocation is accepted', async () => {
  const { capability, invocation } = await invocationCreatedAt(secondsAgo(5))
  const result = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)
  assert.equal(result.ok, true, result.message)
})

test('an invocation older than the window is rejected as stale, not as a bad signature', async () => {
  const { capability, invocation } = await invocationCreatedAt(
    secondsAgo(DEFAULT_INVOCATION_MAX_AGE_SECONDS + 60),
  )
  const result = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)

  assert.equal(result.ok, false)
  assert.equal(result.code, 'INVOCATION_INVALID')
  // The distinction matters operationally: a stale replay and a forged
  // proof warrant very different responses.
  assert.match(result.message ?? '', /freshness window/)
  assert.ok(result.problems?.some((p) => p.typeURI.includes('INVOCATION_STALE')))
})

test('the signature is still what proves authenticity — a stale one is not accepted by widening the window', async () => {
  // Same invocation, generous window: now accepted, proving the rejection
  // above was the clock and not a broken proof.
  const { capability, invocation } = await invocationCreatedAt(
    secondsAgo(DEFAULT_INVOCATION_MAX_AGE_SECONDS + 60),
  )
  const result = checkInvocation(
    realConfig({ invocationMaxAgeSeconds: 24 * 60 * 60 }),
    { chain: [capability], invocation },
    AUTH_QUERY,
  )
  assert.equal(result.ok, true, result.message)
})

test('a boundary-fresh invocation is still accepted', async () => {
  const { capability, invocation } = await invocationCreatedAt(
    secondsAgo(DEFAULT_INVOCATION_MAX_AGE_SECONDS - 30),
  )
  const result = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)
  assert.equal(result.ok, true, result.message)
})

test('a client clock running slightly fast is tolerated', async () => {
  // Clocks drift forward as often as backward; rejecting those is the
  // same outage as rejecting stale ones.
  const { capability, invocation } = await invocationCreatedAt(
    secondsAgo(-(DEFAULT_INVOCATION_CLOCK_SKEW_SECONDS - 20)),
  )
  const result = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)
  assert.equal(result.ok, true, result.message)
})

test('a created far in the future is rejected — otherwise it is an unbounded replay window', async () => {
  const { capability, invocation } = await invocationCreatedAt(secondsAgo(-3600))
  const result = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)

  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /in the future/)
})

test('invocationMaxAgeSeconds: 0 disables the check', async () => {
  const { capability, invocation } = await invocationCreatedAt(secondsAgo(365 * 24 * 60 * 60))
  const result = checkInvocation(
    realConfig({ invocationMaxAgeSeconds: 0 }),
    { chain: [capability], invocation },
    AUTH_QUERY,
  )
  assert.equal(result.ok, true, result.message)
})

test('an unparseable created is rejected rather than treated as fresh', async () => {
  const { capability, invocation } = await invocationCreatedAt('not-a-date')
  const result = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)

  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /not parseable/)
})

test('a missing created fails closed', async () => {
  // Every signer in use sets `created`, so its absence is either a broken
  // client or an attempt to opt out of the window. Treating it as fresh
  // would make the check trivially bypassable.
  const capability = await delegateGraphqlZcap(agent, issuer, invoker)
  const invocation = await invokeGraphqlZcap(agent, invoker, capability, AUTH_QUERY, GRAPHQL_ENDPOINT)
  const proof = (invocation as unknown as { proof: Record<string, unknown> }).proof
  delete proof.created

  const result = checkInvocation(realConfig(), { chain: [capability], invocation }, AUTH_QUERY)
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /missing "created"/)
})
