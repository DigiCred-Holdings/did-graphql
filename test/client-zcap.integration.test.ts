import './helpers/askarSetup.js'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Agent } from '@credo-ts/core'

import { DidGraphQLClient } from '../client/src/client.js'
import { decodeInvocationHeader } from '../client/src/zcap.js'
import { InvalidCapabilityError } from '../client/src/errors.js'
import { validateGraphqlZcap } from '../client/src/validate.js'
import { createDidKey, createTestAgent, type DidKeyPair } from './helpers/credoAgent.js'
import { verifyDataIntegrityProof } from './helpers/eddsaJcs2022.js'
import { AUTH_QUERY, GRAPHQL_ENDPOINT, delegateGraphqlZcap } from './helpers/zcapFixtures.js'

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

test('delegated GraphQL ZCAP passes the wallet validation algorithm', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  assert.equal(capability.controller, holder.did)
  assert.equal(capability.invocationTarget, GRAPHQL_ENDPOINT)
  assert.deepEqual(capability.allowedAction, [AUTH_QUERY])
  assert.equal(capability.proof?.type, 'DataIntegrityProof')
  assert.equal(capability.proof?.cryptosuite, 'eddsa-jcs-2022')
  assert.equal(capability.proof?.proofPurpose, 'capabilityDelegation')
  assert.equal(capability.proof?.verificationMethod, issuer.verificationMethod)
  assert.equal(await verifyDataIntegrityProof(agent, issuer, capability as unknown as Record<string, unknown>), true)

  const validated = validateGraphqlZcap(capability, {
    expectedInvocationTarget: GRAPHQL_ENDPOINT,
  })
  assert.equal(validated.invocationTarget, GRAPHQL_ENDPOINT)
})

test('validation refuses a ZCAP whose invocationTarget is not the GraphQL endpoint', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder, 'https://evil.example/not-graphql')
  assert.throws(() => validateGraphqlZcap(capability), InvalidCapabilityError)
})

test('DidGraphQLClient.checkAuth sends an unsigned query Auth { zcap { valid } } diagnostic', async () => {
  const capability = await delegateGraphqlZcap(agent, issuer, holder)
  let capturedHeader: string | undefined
  let capturedBody: string | undefined

  const client = new DidGraphQLClient({
    capability,
    expectedInvocationTarget: GRAPHQL_ENDPOINT,
    fetchImpl: (async (_url, init) => {
      capturedHeader = (init as RequestInit).headers
        ? ((init as RequestInit).headers as Record<string, string>)['x-zcap-invocation']
        : undefined
      capturedBody = typeof (init as RequestInit).body === 'string' ? ((init as RequestInit).body as string) : undefined
      return new Response(JSON.stringify({ data: { zcap: { valid: true } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })

  assert.equal(await client.checkAuth(), true)
  assert.ok(capturedHeader)
  const payload = decodeInvocationHeader(capturedHeader)
  assert.equal(payload.chain[0]?.id, capability.id)
  assert.equal(payload.invocation, undefined)
  assert.equal(JSON.parse(capturedBody ?? '{}').query, AUTH_QUERY)
})
