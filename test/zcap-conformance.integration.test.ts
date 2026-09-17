// Two fields the ZCAP data model defines that this library previously
// accepted and never read. Both sit inside the delegation signature, so
// both are authorization-relevant — ignoring them is a decision, and it
// was the wrong one in the permissive direction.

import './helpers/askarSetup.js'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Agent } from '@credo-ts/core'

import { checkAuthOnly, configureZcap, type RealZcapServerConfig } from '../server/src/zcap.js'
import { createDidKey, createTestAgent, type DidKeyPair } from './helpers/credoAgent.js'
import {
  AUTH_QUERY,
  GRAPHQL_ENDPOINT,
  delegateGraphqlZcap,
  materializeRoot,
  rootCapabilityId,
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

// --- caveat ---------------------------------------------------------

test('a capability with no caveat is unaffected', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, invoker)
  const result = await checkAuthOnly(realConfig(), { chain: [capability] })
  assert.equal(result.valid, true, result.reason ?? undefined)
})

test('an unevaluable caveat is refused, not ignored', async () => {
  // The delegator signed a restriction. Honouring the capability while
  // ignoring the restriction grants strictly more than they intended,
  // which is the one direction a verifier must not fail in.
  const capability = await delegateGraphqlZcap(agent, issuer, invoker, GRAPHQL_ENDPOINT, [AUTH_QUERY], {
    caveat: [{ type: 'ValidWhileTrue', condition: 'something this verifier knows nothing about' }],
  })

  const result = await checkAuthOnly(realConfig(), { chain: [capability] })
  assert.equal(result.valid, false)
  assert.match(result.reason ?? '', /caveat/)
  assert.ok(result.problems?.some((p) => p.typeURI.includes('CAVEAT_UNSUPPORTED')))
})

test('allowUnsupportedCaveats accepts it, for a deployment that knows its caveats are advisory', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, invoker, GRAPHQL_ENDPOINT, [AUTH_QUERY], {
    caveat: [{ type: 'ValidWhileTrue' }],
  })

  const result = await checkAuthOnly(realConfig({ allowUnsupportedCaveats: true }), { chain: [capability] })
  assert.equal(result.valid, true, result.reason ?? undefined)
})

test('a caveat without a type is still refused', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, invoker, GRAPHQL_ENDPOINT, [AUTH_QUERY], {
    caveat: [{ expiresAfterUses: 3 }],
  })

  const result = await checkAuthOnly(realConfig(), { chain: [capability] })
  assert.equal(result.valid, false)
  assert.match(result.reason ?? '', /caveat/)
})

// --- capabilityChain ------------------------------------------------

test('a capabilityChain naming the resolved root is accepted', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, invoker, GRAPHQL_ENDPOINT, [AUTH_QUERY], {
    proofOptions: { capabilityChain: [rootCapabilityId(GRAPHQL_ENDPOINT)] },
  })

  const result = await checkAuthOnly(realConfig(), { chain: [capability] })
  assert.equal(result.valid, true, result.reason ?? undefined)
})

test('a capabilityChain naming a different root is refused', async () => {
  // Signed, so an attacker cannot forge it — but previously it was read
  // by nothing at all, so a capability could assert one chain while
  // being verified against another.
  const capability = await delegateGraphqlZcap(agent, issuer, invoker, GRAPHQL_ENDPOINT, [AUTH_QUERY], {
    proofOptions: { capabilityChain: ['urn:zcap:root:https%3A%2F%2Fsomewhere.else%2Fgraphql'] },
  })

  const result = await checkAuthOnly(realConfig(), { chain: [capability] })
  assert.equal(result.valid, false)
  assert.ok(result.problems?.some((p) => p.typeURI.includes('CAPABILITY_CHAIN_MISMATCH')))
})

test('a multi-level capabilityChain is refused rather than partly checked', async () => {
  // This verifier only understands root -> leaf. Accepting a longer
  // chain would mean verifying one link and taking the rest on trust.
  const capability = await delegateGraphqlZcap(agent, issuer, invoker, GRAPHQL_ENDPOINT, [AUTH_QUERY], {
    proofOptions: {
      capabilityChain: [rootCapabilityId(GRAPHQL_ENDPOINT), 'urn:zcap:delegated:intermediate'],
    },
  })

  const result = await checkAuthOnly(realConfig(), { chain: [capability] })
  assert.equal(result.valid, false)
  assert.match(result.reason ?? '', /single-level/)
})

test('the default delegation already carries a conformant capabilityChain', async () => {
  // Worth pinning: the signer has always emitted `capabilityChain`, this
  // library just never read it. That is why adding the check changed no
  // existing behaviour — and why a regression in the signer would now
  // surface here rather than silently.
  const capability = await delegateGraphqlZcap(agent, issuer, invoker)
  const chain = (capability.proof as Record<string, unknown> | undefined)?.capabilityChain
  assert.deepEqual(chain, [rootCapabilityId(GRAPHQL_ENDPOINT)])

  const result = await checkAuthOnly(realConfig(), { chain: [capability] })
  assert.equal(result.valid, true, result.reason ?? undefined)
})
