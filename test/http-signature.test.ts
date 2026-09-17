// RFC 9421 HTTP Message Signatures — the ZCAP spec's own invocation proof.
//
// The signature base is built independently in both packages (the server
// cannot import the client), so the first test here is the load-bearing
// one: if those two ever drift, every signature fails with an opaque
// "signature failed verification" and nothing points at the cause.

import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { test } from 'node:test'

import {
  buildSignatureBase as clientBuildBase,
  contentDigest,
  pathOf as clientPathOf,
  signRequest,
  type HttpSignatureSigner,
} from '../client/src/httpSignature.js'
import { encodeCapabilityInvocation } from '../client/src/zcap.js'
import type { Capability } from '../client/src/types.js'
import {
  buildSignatureBase as serverBuildBase,
  pathOf as serverPathOf,
  verifyHttpSignature,
} from '../server/src/httpSignature.js'
import { checkInvocation, configureZcap } from '../server/src/zcap.js'

const ENDPOINT = 'https://api.example.org/graphql'
const QUERY = 'query A { a }'

/** did:key multicodec prefix for an Ed25519 public key. */
function didKeyFromPublicKey(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(publicKey.length + 2)
  prefixed[0] = 0xed
  prefixed[1] = 0x01
  prefixed.set(publicKey, 2)
  // base58btc, as did:key requires
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let digits = [0]
  for (const byte of prefixed) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (const byte of prefixed) {
    if (byte === 0) out += '1'
    else break
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!]
  return `did:key:z${out}`
}

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = new Uint8Array(publicKey.export({ format: 'jwk' }).x as unknown as string
    ? Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')
    : [])
  const did = didKeyFromPublicKey(raw)
  const keyid = `${did}#${did.slice('did:key:'.length)}`
  const signer: HttpSignatureSigner = {
    keyid,
    sign: (base) => new Uint8Array(cryptoSign(null, Buffer.from(base, 'utf8'), privateKey)),
  }
  return { signer, did, keyid, privateKey }
}

function capabilityFor(controller: string): Capability {
  return {
    '@context': ['https://w3id.org/zcap/v1'],
    id: 'urn:zcap:delegated:test',
    controller,
    invocationTarget: ENDPOINT,
    parentCapability: 'urn:zcap:root:https%3A%2F%2Fapi.example.org%2Fgraphql',
    allowedAction: [QUERY],
    expires: new Date(Date.now() + 3600e3).toISOString(),
    proof: { type: 'DataIntegrityProof', verificationMethod: `${controller}#k` },
  } as unknown as Capability
}

test('the two independent signature-base builders agree byte-for-byte', () => {
  // This is the whole reason the duplication is acceptable. It must run
  // over values with the awkward shapes — a long base64url capability,
  // a digest containing colons and padding — not just simple ones.
  const input = {
    method: 'post',
    path: '/graphql',
    capabilityInvocation: 'zcap capability=H4sIAAAAAAAAA_NIzcnJVyjPL8pJUQQAlRmFGwsAAAA',
    contentDigest: 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
    contentType: 'application/json',
    keyid: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    created: 1798294620,
  }
  assert.equal(clientBuildBase(input), serverBuildBase(input))
  assert.equal(clientPathOf(ENDPOINT), serverPathOf(ENDPOINT))
})

test('the base has the shape RFC 9421 specifies', () => {
  const base = clientBuildBase({
    method: 'POST',
    path: '/api/v1/example',
    capabilityInvocation: 'zcap capability=abc',
    contentDigest: 'sha-256=:xyz=:',
    contentType: 'application/json',
    keyid: 'did:key:zAlice#zAlice',
    created: 1798294620,
  })
  const lines = base.split('\n')
  assert.deepEqual(lines.slice(0, 5), [
    '"@method": POST',
    '"@path": /api/v1/example',
    '"capability-invocation": zcap capability=abc',
    '"content-digest": sha-256=:xyz=:',
    '"content-type": application/json',
  ])
  assert.equal(
    lines[5],
    '"@signature-params": ("@method" "@path" "capability-invocation" "content-digest" "content-type");alg="ed25519";created=1798294620;keyid="did:key:zAlice#zAlice"',
  )
  assert.equal(lines.length, 6, 'no trailing newline')
})

test('Content-Digest matches RFC 9530 and the sha-256 of the body', () => {
  // Empty string sha-256, the standard known value.
  assert.equal(contentDigest(''), 'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:')
  assert.match(contentDigest('{"query":"query A { a }"}'), /^sha-256=:[A-Za-z0-9+/]+=*:$/)
})

test('a signed request verifies end to end', async () => {
  const { signer, did } = makeSigner()
  const capability = capabilityFor(did)
  const capabilityInvocation = encodeCapabilityInvocation({ capability })
  const body = JSON.stringify({ query: QUERY })

  const headers = await signRequest({ signer, method: 'POST', endpoint: ENDPOINT, capabilityInvocation, body })

  const result = verifyHttpSignature(
    {
      method: 'POST',
      url: ENDPOINT,
      capabilityInvocation,
      contentType: 'application/json',
      contentDigest: headers['content-digest'],
      signatureInput: headers['signature-input'],
      signature: headers.signature,
      body,
    },
    capability as never,
  )
  assert.equal(result.verified, true, result.reason)
  assert.equal(result.keyid, typeof signer.keyid === 'string' ? signer.keyid : undefined)
})

test('tampering with the body is caught by Content-Digest', async () => {
  const { signer, did } = makeSigner()
  const capability = capabilityFor(did)
  const capabilityInvocation = encodeCapabilityInvocation({ capability })
  const body = JSON.stringify({ query: QUERY })
  const headers = await signRequest({ signer, method: 'POST', endpoint: ENDPOINT, capabilityInvocation, body })

  const result = verifyHttpSignature(
    {
      method: 'POST',
      url: ENDPOINT,
      capabilityInvocation,
      contentType: 'application/json',
      contentDigest: headers['content-digest'],
      signatureInput: headers['signature-input'],
      signature: headers.signature,
      body: JSON.stringify({ query: 'mutation Evil { drop }' }),
    },
    capability as never,
  )
  assert.equal(result.verified, false)
  assert.match(result.reason ?? '', /Content-Digest/)
})

test('each covered component is actually covered', async () => {
  // A component that is listed but not really bound would make the
  // signature weaker than it claims. Vary each one and require failure.
  const { signer, did } = makeSigner()
  const capability = capabilityFor(did)
  const capabilityInvocation = encodeCapabilityInvocation({ capability })
  const body = JSON.stringify({ query: QUERY })
  const headers = await signRequest({ signer, method: 'POST', endpoint: ENDPOINT, capabilityInvocation, body })

  const base = {
    method: 'POST',
    url: ENDPOINT,
    capabilityInvocation,
    contentType: 'application/json',
    contentDigest: headers['content-digest'],
    signatureInput: headers['signature-input'],
    signature: headers.signature,
    body,
  }

  const variants: Record<string, Partial<typeof base>> = {
    '@method': { method: 'PUT' },
    '@path': { url: 'https://api.example.org/other' },
    'capability-invocation': { capabilityInvocation: 'zcap capability=tampered' },
    'content-type': { contentType: 'text/plain' },
  }
  for (const [component, override] of Object.entries(variants)) {
    const result = verifyHttpSignature({ ...base, ...override } as never, capability as never)
    assert.equal(result.verified, false, `${component} is not actually covered by the signature`)
  }
})

test('a signature from a key the capability does not name is refused', async () => {
  const { signer } = makeSigner()
  const other = makeSigner()
  // Capability delegated to someone else entirely.
  const capability = capabilityFor(other.did)
  const capabilityInvocation = encodeCapabilityInvocation({ capability })
  const body = JSON.stringify({ query: QUERY })
  const headers = await signRequest({ signer, method: 'POST', endpoint: ENDPOINT, capabilityInvocation, body })

  const result = verifyHttpSignature(
    {
      method: 'POST',
      url: ENDPOINT,
      capabilityInvocation,
      contentType: 'application/json',
      contentDigest: headers['content-digest'],
      signatureInput: headers['signature-input'],
      signature: headers.signature,
      body,
    },
    capability as never,
  )
  assert.equal(result.verified, false)
  assert.match(result.reason ?? '', /not controlled by capability controller/)
})

test('a missing created is refused — it is the freshness bound', async () => {
  const { signer, did } = makeSigner()
  const capability = capabilityFor(did)
  const capabilityInvocation = encodeCapabilityInvocation({ capability })
  const body = JSON.stringify({ query: QUERY })
  const headers = await signRequest({ signer, method: 'POST', endpoint: ENDPOINT, capabilityInvocation, body })

  const result = verifyHttpSignature(
    {
      method: 'POST',
      url: ENDPOINT,
      capabilityInvocation,
      contentType: 'application/json',
      contentDigest: headers['content-digest'],
      signatureInput: headers['signature-input']!.replace(/;created=\d+/, ''),
      signature: headers.signature,
      body,
    },
    capability as never,
  )
  assert.equal(result.verified, false)
  assert.match(result.reason ?? '', /created/)
})

test('unsafeMode deliberately skips signature verification', () => {
  // Documented behaviour, worth pinning: unsafeMode short-circuits every
  // proof check, so an HTTP signature is not verified there either. A
  // reader who saw the signature path added might reasonably assume
  // otherwise.
  const config = configureZcap({
    unsafeMode: true,
    trust: { trustedRootController: 'did:key:z6Mk', expectedInvocationTarget: ENDPOINT },
  })
  const capability = capabilityFor('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')
  const result = checkInvocation(config, { chain: [capability as never] }, QUERY, {
    method: 'POST',
    url: ENDPOINT,
    capabilityInvocation: 'zcap capability=whatever',
    contentType: 'application/json',
    contentDigest: 'sha-256=:bogus:',
    signatureInput: 'zcap=();alg="ed25519";created=1;keyid="did:key:z6Mk#z6Mk"',
    signature: 'zcap=:bogus:',
    body: JSON.stringify({ query: QUERY }),
  })
  assert.equal(result.ok, true, 'unsafeMode should accept without verifying')
})
