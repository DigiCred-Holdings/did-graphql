import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import { hashEddsaJcs2022 } from '../client/src/eddsaJcs2022.ts'
import {
  createUnsignedCapabilityInvocation,
  finalizeCapabilityInvocation,
  ZCAP_CONTEXT,
  DATA_INTEGRITY_CONTEXT,
} from '../client/src/invocation.ts'

test('hashEddsaJcs2022 matches CRMS Python fixture byte-for-byte', () => {
  const document = {
    '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
    id: 'urn:uuid:00000000-0000-0000-0000-000000000000',
  }
  const proofOptions = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    proofPurpose: 'capabilityInvocation',
    verificationMethod:
      'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    created: '2026-01-01T00:00:00Z',
    capability: 'urn:zcap:test',
    capabilityAction: 'query Test { zcap { valid } }',
    invocationTarget: 'https://example.com/graphql',
  }
  const expectedHex =
    '653b45fe22f29e06472cb53dd203b43b90716faa7a436175cf03b8777e6101ccbd9e1888dd1181dc028db893d38672248ad53b4a66ebcca2a72e2b812f597b14'

  const hash = hashEddsaJcs2022(document, proofOptions)
  assert.equal(Buffer.from(hash).toString('hex'), expectedHex)
  assert.equal(hash.length, 64)
})

test('createUnsigned + finalize assembles a SignedInvocation', () => {
  const { document, proofOptions, hash } = createUnsignedCapabilityInvocation({
    capabilityId: 'urn:zcap:test',
    capabilityAction: 'query Auth { zcap { valid } }',
    invocationTarget: 'https://example.com/graphql',
    verificationMethod: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    created: '2026-01-01T00:00:00Z',
    id: 'urn:uuid:00000000-0000-0000-0000-000000000001',
  })

  assert.deepEqual(document['@context'], [ZCAP_CONTEXT, DATA_INTEGRITY_CONTEXT])
  assert.equal(hash.length, 64)

  const signature = new Uint8Array(64).fill(1)
  const invocation = finalizeCapabilityInvocation(document, proofOptions, signature)
  assert.equal(invocation.id, 'urn:uuid:00000000-0000-0000-0000-000000000001')
  assert.equal(typeof invocation.proof.proofValue, 'string')
  assert.ok(String(invocation.proof.proofValue).startsWith('z'))
})
