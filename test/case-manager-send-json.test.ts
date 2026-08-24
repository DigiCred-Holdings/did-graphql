import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { test } from 'node:test'

import { sendJson } from '../examples/case-manager/sendJson.js'

function mockResponse() {
  let statusCode = 0
  let headers: Record<string, string | string[] | undefined> = {}
  let body: Buffer | string | undefined
  return {
    res: {
      writeHead(code: number, h: Record<string, string>) {
        statusCode = code
        headers = h
      },
      end(chunk: Buffer | string) {
        body = chunk
      },
    },
    get() {
      return { statusCode, headers, body }
    },
  }
}

test('sendJson returns plain JSON when Accept-Encoding is absent', () => {
  const payload = { data: { cfDocuments: { items: [{ title: 'Wyoming Higher Education' }], totalCount: 1 } } }
  const { res, get } = mockResponse()
  sendJson({ headers: {} } as import('node:http').IncomingMessage, res as import('node:http').ServerResponse, 200, payload)
  const out = get()
  assert.equal(out.statusCode, 200)
  assert.equal(out.headers['content-type'], 'application/json')
  assert.equal(out.headers['content-encoding'], undefined)
  assert.deepEqual(JSON.parse(String(out.body)), payload)
})

test('sendJson gzips when Accept-Encoding includes gzip', () => {
  const payload = { data: { cfItems: { items: [{ fullStatement: 'x'.repeat(500) }], totalCount: 1 } } }
  const { res, get } = mockResponse()
  sendJson(
    { headers: { 'accept-encoding': 'gzip, deflate' } } as import('node:http').IncomingMessage,
    res as import('node:http').ServerResponse,
    200,
    payload,
  )
  const out = get()
  assert.equal(out.headers['content-encoding'], 'gzip')
  const inflated = gunzipSync(out.body as Buffer)
  assert.deepEqual(JSON.parse(inflated.toString('utf8')), payload)
  assert.ok((out.body as Buffer).length < inflated.length)
})
