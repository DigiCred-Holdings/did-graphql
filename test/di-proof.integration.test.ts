import './helpers/askarSetup.js'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Agent } from '@credo-ts/core'

import { createDidKey, createDidKeyFromSeed, createTestAgent, type DidKeyPair } from './helpers/credoAgent.js'
import { addDataIntegrityProof, verifyDataIntegrityProof, verifyDataIntegrityProofByController } from './helpers/eddsaJcs2022.js'

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

test('createDidKeyFromSeed is deterministic — same seed always yields the same did:key', async () => {
  const first = await createDidKeyFromSeed(agent, 'case-manager-test-seed')
  const second = await createDidKeyFromSeed(agent, 'case-manager-test-seed')
  assert.equal(first.did, second.did)
  assert.equal(first.verificationMethod, second.verificationMethod)

  const different = await createDidKeyFromSeed(agent, 'a-different-seed')
  assert.notEqual(different.did, first.did)
})

test('createDidKeyFromSeed identity signs a real, verifiable eddsa-jcs-2022 proof', async () => {
  const seeded = await createDidKeyFromSeed(agent, 'case-manager-test-seed')
  const secured = await addDataIntegrityProof(agent, seeded, { hello: 'seeded' }, { proofPurpose: 'assertionMethod' })
  const proof = secured.proof as Record<string, unknown>
  assert.equal(proof.verificationMethod, seeded.verificationMethod)
  assert.equal(await verifyDataIntegrityProof(agent, seeded, secured), true)
})

// verifyDataIntegrityProofByController is what a resource server actually
// needs: verifying a capability signed by someone else's key, using
// only the did:key string presented on the wire — no pre-registered
// signer, unlike verifyDataIntegrityProof above.
test('verifyDataIntegrityProofByController verifies purely from the did:key in the proof, on a fresh agent with no prior knowledge of the signer', async () => {
  const secured = await addDataIntegrityProof(agent, issuer, { capability: 'demo' }, { proofPurpose: 'capabilityDelegation' })

  const verifierAgent = await createTestAgent() // never called createDidKey for `issuer` — nothing to look up locally
  try {
    assert.equal(await verifyDataIntegrityProofByController(verifierAgent, secured), true)
  } finally {
    await verifierAgent.shutdown()
  }
})

test('verifyDataIntegrityProofByController rejects a tampered document', async () => {
  const secured = await addDataIntegrityProof(agent, issuer, { capability: 'demo' }, { proofPurpose: 'capabilityDelegation' })
  const tampered = { ...secured, capability: 'tampered' }
  assert.equal(await verifyDataIntegrityProofByController(agent, tampered), false)
})

test('verifyDataIntegrityProofByController rejects a proof claiming a different controller than actually signed it', async () => {
  const secured = await addDataIntegrityProof(agent, issuer, { capability: 'demo' }, { proofPurpose: 'capabilityDelegation' })
  const proof = secured.proof as Record<string, unknown>
  const relabeled = { ...secured, proof: { ...proof, verificationMethod: holder.verificationMethod } }
  assert.equal(await verifyDataIntegrityProofByController(agent, relabeled), false)
})

test('verifyDataIntegrityProofByController rejects the unsigned placeholder shape', async () => {
  const unsigned = {
    id: 'urn:zcap:placeholder',
    controller: 'did:example:demo',
    proof: { type: 'none', verificationMethod: 'did:example:demo#unsafe' },
  }
  assert.equal(await verifyDataIntegrityProofByController(agent, unsigned), false)
})
