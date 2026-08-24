import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clearCasePackageCache, getCFPackage, type CaseConfig, type CFPackage } from '../server/src/case/client.js'

const MOCK_PACKAGE: CFPackage = {
  CFDocument: { identifier: 'pkg-1', uri: 'https://case.example/pkg-1', title: 'Demo Framework' },
  CFItems: [{ identifier: 'item-1', CFItemType: 'Program', fullStatement: 'Program One' }],
  CFAssociations: [],
}

const ETAG = '"pkg-1-2024-01-01T00:00:00Z"'

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const record = headers as Record<string, string>
  return record[name] ?? record[name.toLowerCase()]
}

function createEtagMock() {
  let fetchCount = 0
  let lastIfNoneMatch: string | undefined

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    fetchCount++
    lastIfNoneMatch = headerValue(init?.headers, 'if-none-match')

    if (url.includes('/CFPackages/pkg-1')) {
      if (lastIfNoneMatch === ETAG) {
        return new Response(null, { status: 304, headers: { etag: ETAG } })
      }
      return new Response(JSON.stringify(MOCK_PACKAGE), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: ETAG },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  return {
    fetchImpl,
    get fetchCount() {
      return fetchCount
    },
    get lastIfNoneMatch() {
      return lastIfNoneMatch
    },
  }
}

const baseConfig = {
  baseUrl: 'https://case.example',
  packageId: 'pkg-1',
  ttlMs: 0,
} satisfies Omit<CaseConfig, 'fetchImpl'>

test('CFPackage fetch revalidates with If-None-Match and reuses body on 304', async () => {
  clearCasePackageCache()
  const mock = createEtagMock()
  const config: CaseConfig = { ...baseConfig, fetchImpl: mock.fetchImpl }

  const first = await getCFPackage(config, 'pkg-1')
  assert.deepEqual(first, MOCK_PACKAGE)
  assert.equal(mock.fetchCount, 1)
  assert.equal(mock.lastIfNoneMatch, undefined)

  const second = await getCFPackage(config, 'pkg-1')
  assert.deepEqual(second, MOCK_PACKAGE)
  assert.equal(mock.fetchCount, 2)
  assert.equal(mock.lastIfNoneMatch, ETAG)
})

test('CFPackage fetch stays backward compatible when go-case sends no ETag', async () => {
  clearCasePackageCache()
  let fetchCount = 0
  let lastIfNoneMatch: string | undefined

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCount++
    lastIfNoneMatch = headerValue(init?.headers, 'if-none-match')
    if (String(input).includes('/CFPackages/pkg-1')) {
      return new Response(JSON.stringify(MOCK_PACKAGE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const config: CaseConfig = { ...baseConfig, fetchImpl }

  await getCFPackage(config, 'pkg-1')
  await getCFPackage(config, 'pkg-1')

  assert.equal(fetchCount, 2)
  assert.equal(lastIfNoneMatch, undefined)
})

test('CFPackage fetch accepts a fresh 200 when server ignores If-None-Match', async () => {
  clearCasePackageCache()
  const updated: CFPackage = {
    ...MOCK_PACKAGE,
    CFItems: [{ identifier: 'item-2', CFItemType: 'Program', fullStatement: 'Program Two' }],
  }

  let fetchCount = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCount++
    const ifNoneMatch = headerValue(init?.headers, 'if-none-match')
    if (String(input).includes('/CFPackages/pkg-1')) {
      if (ifNoneMatch) {
        return new Response(JSON.stringify(updated), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"pkg-1-updated"' },
        })
      }
      return new Response(JSON.stringify(MOCK_PACKAGE), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: ETAG },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const config: CaseConfig = { ...baseConfig, fetchImpl }

  await getCFPackage(config, 'pkg-1')
  const second = await getCFPackage(config, 'pkg-1')

  assert.equal(fetchCount, 2)
  assert.deepEqual(second, updated)
})
