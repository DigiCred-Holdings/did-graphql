import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'

import {
  decodeJsonBody,
  inflateGzipWithFflate,
  isGzipMagic,
  readJsonResponse,
} from '../client/src/gzip.js'

const payload = { data: { colleges: { items: [{ name: 'Utopia HS' }], totalCount: 1 } } }
const json = JSON.stringify(payload)

test('plain JSON bytes are not treated as gzip', async () => {
  const bytes = new TextEncoder().encode(json)
  assert.equal(isGzipMagic(bytes), false)
  assert.deepEqual(await decodeJsonBody(bytes), payload)
})

test('gzip magic is detected and inflated (native or fflate)', async () => {
  const gz = new Uint8Array(gzipSync(Buffer.from(json)))
  assert.equal(isGzipMagic(gz), true)
  assert.deepEqual(await decodeJsonBody(gz), payload)
})

test('fflate path inflates the same bytes React Native would see', () => {
  const gz = new Uint8Array(gzipSync(Buffer.from(json)))
  const inflated = inflateGzipWithFflate(gz)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(inflated)), payload)
})

test('fflate path throws a clear error on truncated gzip', () => {
  const gz = new Uint8Array(gzipSync(Buffer.from(json)))
  assert.throws(() => inflateGzipWithFflate(gz.subarray(0, 8)), /gzip inflate failed/)
})

test('Content-Encoding gzip with already-decompressed body still parses', async () => {
  // Node/browser fetch may strip compression but leave the header.
  const res = new Response(json, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
  })
  assert.deepEqual(await readJsonResponse(res), payload)
})

test('gzip body round-trips through readJsonResponse', async () => {
  const gz = gzipSync(Buffer.from(json))
  const res = new Response(gz, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
  })
  assert.deepEqual(await readJsonResponse(res), payload)
})
