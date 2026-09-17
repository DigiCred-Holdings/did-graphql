// The Capability-Invocation header: the client encodes with fflate, the
// server decodes with node:zlib. Those are different implementations of
// gzip, so most of what is worth testing here is that they agree — a
// format mismatch would otherwise ship silently and only fail in
// production, where it looks like an auth failure.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'

import {
  DEFAULT_MAX_HEADER_BYTES,
  prepareDiagnosticRequest,
  prepareInvokedRequest,
} from '../client/src/client.js'
import { InvocationHeaderTooLargeError } from '../client/src/errors.js'
import { encodeCapabilityInvocation, encodeInvocationHeader } from '../client/src/zcap.js'
import type { Capability, SignedInvocation } from '../client/src/types.js'
import { decodeInvocationHeader, describeInvocationHeader } from '../server/src/zcap.js'

const ENDPOINT = 'https://api.example.org/graphql'

function capabilityWith(allowedAction: string[]): Capability {
  return {
    '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
    id: 'urn:uuid:8f2b1c30-1f2a-4c0e-9f8e-2a1b3c4d5e6f',
    parentCapability: 'urn:zcap:root:https%3A%2F%2Fapi.example.org%2Fgraphql',
    invocationTarget: ENDPOINT,
    controller: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    expires: '2027-01-01T00:00:00Z',
    allowedAction,
    proof: {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: '2026-09-17T18:00:00Z',
      verificationMethod: 'did:key:z6Mk#z6Mk',
      proofPurpose: 'capabilityDelegation',
      proofValue: 'z3MvGcVxzRzzpKF1YP7d',
    },
  } as unknown as Capability
}

const invocation = {
  '@context': ['https://w3id.org/zcap/v1'],
  id: 'urn:uuid:aaaa',
  proof: {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-09-17T18:00:00Z',
    verificationMethod: 'did:key:z6Mk#z6Mk',
    proofPurpose: 'capabilityInvocation',
    capability: 'urn:uuid:8f2b1c30-1f2a-4c0e-9f8e-2a1b3c4d5e6f',
    capabilityAction: 'query A { a }',
    invocationTarget: ENDPOINT,
    proofValue: 'z3MvGcVxzRzz',
  },
} as unknown as SignedInvocation

// Nine documents sharing heavy token structure, like the real deployment
// that forced this change — compressing them together is what makes the
// header fit, so the fixture has to look like that rather than be nine
// unrelated strings.
const NINE_QUERIES = Array.from(
  { length: 9 },
  (_, i) =>
    `query Q${i}($limit: Int, $region: String) { colleges(limit: $limit, filter: {region: $region, sector: "s${i}"}, priority: [{field: "name", includes: ["A"]}]) { items { id name city state zip url sector controlOfInstitution admissionsUrl netPriceCalculatorUrl programs(limit: 10) { id title credentialType cipCode level durationMonths tuitionInState tuitionOutOfState applicationDeadline modality accreditingBody } } groups { key count } } programs(limit: $limit, groupBy: "areaOfStudy") { items { id title credentialType cipCode areaOfStudy occupations { id title socCode medianWage } } groups { key count } } }`,
)

test('client gzip and server gunzip agree — the whole point of the format', () => {
  const header = encodeCapabilityInvocation({ capability: capabilityWith(['query A { a }']), invocation })
  const payload = decodeInvocationHeader(header)

  assert.ok(payload, 'server could not decode what the client produced')
  assert.equal(payload.chain[0]?.id, 'urn:uuid:8f2b1c30-1f2a-4c0e-9f8e-2a1b3c4d5e6f')
  assert.deepEqual(payload.chain[0]?.allowedAction, ['query A { a }'])
  assert.equal(payload.invocation?.proof?.capabilityAction, 'query A { a }')
})

test('the capability survives byte-identically — signatures verify over what came out', () => {
  // The delegation proof covers every field except `proof` itself, so a
  // transport that altered so much as key order would break verification
  // while looking fine here. Compare the canonical JSON, not just fields.
  const capability = capabilityWith(NINE_QUERIES)
  const decoded = decodeInvocationHeader(encodeCapabilityInvocation({ capability }))
  assert.equal(JSON.stringify(decoded?.chain[0]), JSON.stringify(capability))
})

test('follows the ZCAP HTTP binding shape', () => {
  const header = encodeCapabilityInvocation({ capability: capabilityWith(['query A { a }']) })
  const value = /^zcap capability="([^"]*)"$/.exec(header)?.[1]
  assert.ok(value)
  // base64url, unpadded: no +, / or = in the VALUE, so it never needs
  // escaping inside the quoted parameter.
  assert.doesNotMatch(value, /[+/=]/)
})

test('a realistic 9-query capability fits well under the 8KB host limit', () => {
  const header = encodeCapabilityInvocation({ capability: capabilityWith(NINE_QUERIES), invocation })
  const uncompressed = encodeInvocationHeader({ chain: [capabilityWith(NINE_QUERIES)], invocation })

  assert.ok(
    header.length < DEFAULT_MAX_HEADER_BYTES,
    `header is ${header.length} bytes, over the ${DEFAULT_MAX_HEADER_BYTES} limit`,
  )
  // Guards the reason this change exists: deployed hosts cut off between
  // 8KB and 16KB, and the legacy encoding of this same capability is
  // over that. If a future change reinflates the header, fail here
  // rather than in production behind a proxy returning a bare 400.
  assert.ok(uncompressed.length > DEFAULT_MAX_HEADER_BYTES, 'fixture no longer reproduces the size problem')
  assert.ok(header.length < uncompressed.length / 3)
})

test('legacy x-zcap-invocation still decodes — old clients keep working', () => {
  const legacy = encodeInvocationHeader({ chain: [capabilityWith(['query A { a }'])], invocation })
  const payload = decodeInvocationHeader(undefined, legacy)

  assert.ok(payload)
  assert.deepEqual(payload.chain[0]?.allowedAction, ['query A { a }'])
  assert.equal(payload.invocation?.proof?.capabilityAction, 'query A { a }')
})

test('a legacy value passed as the only argument is still decoded', () => {
  // A server that reads one header and cannot say which it came from
  // should not have to care during the migration.
  const legacy = encodeInvocationHeader({ chain: [capabilityWith(['query A { a }'])] })
  assert.ok(decodeInvocationHeader(legacy))
})

test('malformed input returns null instead of throwing', () => {
  for (const bad of [
    'zcap capability="not-base64url-gzip"',
    'zcap capability=""',
    'zcap',
    'zcap invocation="x"', // no capability parameter
    'Bearer abc123',
    encodeCapabilityInvocation({ capability: capabilityWith(['query A { a }']) }).slice(0, 40), // truncated
  ]) {
    assert.equal(decodeInvocationHeader(bad), null, `expected null for: ${bad}`)
  }
})

test('refuses a decompression bomb rather than inflating it', () => {
  // ~1MB of zeroes compresses to about a kilobyte. Without a bounded
  // inflate this is a trivial memory-exhaustion vector, and it is newly
  // reachable now that the server decompresses attacker-controlled bytes.
  const bomb = gzipSync(Buffer.alloc(1024 * 1024)).toString('base64url')
  assert.equal(decodeInvocationHeader(`zcap capability="${bomb}"`), null)
})

test('distinguishes an absent header from an unusable one', () => {
  // Before this, a proxy-truncated header and a client that sent none
  // both surfaced as "missing capability" — which is what made the
  // original size failure read as something else entirely.
  assert.equal(describeInvocationHeader(undefined).reason, 'absent')
  assert.equal(describeInvocationHeader('zcap capability="garbage"').reason, 'undecodable')
  assert.equal(
    describeInvocationHeader(encodeCapabilityInvocation({ capability: capabilityWith(['query A { a }']) })).reason,
    'ok',
  )
})

test('refuses to send an oversized header, naming the real cause', () => {
  // Random hex, so gzip cannot rescue it — this is the genuine "far too
  // much granted" case rather than a compressible one.
  const huge = Array.from({ length: 200 }, (_, i) => `query Q${i} { ${randomBytes(400).toString('hex')} }`)
  const capability = capabilityWith(huge)

  let err: unknown
  try {
    prepareInvokedRequest(invocation, [capability], { query: 'query A { a }' })
  } catch (caught) {
    err = caught
  }

  assert.ok(err instanceof InvocationHeaderTooLargeError, `expected InvocationHeaderTooLargeError, got ${err}`)
  assert.equal(err.allowedActionCount, 200)
  assert.ok(err.headerBytes > DEFAULT_MAX_HEADER_BYTES)
  assert.match(err.message, /allowedAction/)
})

test('maxHeaderBytes: 0 disables the ceiling', () => {
  const huge = Array.from({ length: 200 }, (_, i) => `query Q${i} { ${randomBytes(400).toString('hex')} }`)
  assert.doesNotThrow(() =>
    prepareDiagnosticRequest(capabilityWith(huge), { query: 'query A { a }' }, 0),
  )
})

test('prepared requests carry the new header and a JSON body', () => {
  const prepared = prepareDiagnosticRequest(capabilityWith(['query A { a }']), { query: 'query A { a }' })
  assert.equal(prepared.headers['content-type'], 'application/json')
  assert.match(prepared.headers['capability-invocation'], /^zcap capability="/)
  assert.equal(JSON.parse(prepared.body).query, 'query A { a }')
})
