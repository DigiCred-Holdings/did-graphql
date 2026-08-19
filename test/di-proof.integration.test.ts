import './helpers/askarSetup.js'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Agent } from '@credo-ts/core'

import { createDidKey, createTestAgent, type DidKeyPair } from './helpers/credoAgent.js'
import { addDataIntegrityProof, verifyDataIntegrityProof } from './helpers/eddsaJcs2022.js'

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

test('creates two distinct did:key identities with Ed25519 key pairs', () => {
  assert.match(issuer.did, /^did:key:z6Mk/)
  assert.match(holder.did, /^did:key:z6Mk/)
  assert.notEqual(issuer.did, holder.did)
  assert.equal(issuer.verificationMethod.startsWith(`${issuer.did}#`), true)
  assert.equal(holder.verificationMethod.startsWith(`${holder.did}#`), true)
})

test('issuer signs a DataIntegrityProof with eddsa-jcs-2022 via credo-ts KMS', async () => {
  const document = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: 'UnsignedExample',
    hello: 'world',
  }
  const secured = await addDataIntegrityProof(agent, issuer, document, {
    proofPurpose: 'assertionMethod',
  })
  const proof = secured.proof as Record<string, unknown>
  assert.equal(proof.type, 'DataIntegrityProof')
  assert.equal(proof.cryptosuite, 'eddsa-jcs-2022')
  assert.equal(proof.verificationMethod, issuer.verificationMethod)
  assert.equal(typeof proof.proofValue, 'string')
  assert.match(proof.proofValue as string, /^z[1-9A-HJ-NP-Za-km-z]+$/)
  assert.equal(await verifyDataIntegrityProof(agent, issuer, secured), true)
})

test('holder cannot verify a proof the issuer signed (wrong key)', async () => {
  const secured = await addDataIntegrityProof(agent, issuer, { n: 1 }, { proofPurpose: 'assertionMethod' })
  assert.equal(await verifyDataIntegrityProof(agent, holder, secured), false)
})

test('tampering the document invalidates the eddsa-jcs-2022 proof', async () => {
  const secured = await addDataIntegrityProof(agent, issuer, { n: 1 }, { proofPurpose: 'assertionMethod' })
  const tampered = { ...secured, n: 2 }
  assert.equal(await verifyDataIntegrityProof(agent, issuer, tampered), false)
})
