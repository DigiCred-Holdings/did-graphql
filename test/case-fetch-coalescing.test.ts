// Upstream request counts for the CASE client under concurrency and
// many-framework queries (did-graphql#53):
// - concurrent cold requests for one package share one fetch
// - the package cache cap is configurable
// - unknown framework titles don't each re-fetch the CFDocuments listing

import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

import {
  type CaseConfig,
  clearCasePackageCache,
  clearFrameworkPackageIdCache,
  getCFPackage,
  resolveFrameworkPackageId,
} from '../server/src/index.js'

const DOCUMENTS = Array.from({ length: 14 }, (_, i) => ({
  identifier: `pkg-${i}`,
  uri: `https://case.example/pkg-${i}`,
  title: `Framework ${i}`,
}))

function countingConfig(overrides: Partial<CaseConfig> = {}) {
  const calls = { packages: 0, documents: 0 }
  let failNext = false
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    // Yield so concurrent callers genuinely overlap the in-flight request.
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (failNext) {
      failNext = false
      return new Response('upstream down', { status: 503 })
    }
    if (url.includes('/CFDocuments')) {
      calls.documents++
      return Response.json({ CFDocuments: DOCUMENTS })
    }
    const match = url.match(/\/CFPackages\/(.+)$/)
    if (match) {
      calls.packages++
      const id = decodeURIComponent(match[1]!)
      return Response.json({ CFDocument: { identifier: id, uri: '', title: id }, CFItems: [], CFAssociations: [] })
    }
    return new Response('not found', { status: 404 })
  }
  const config: CaseConfig = { baseUrl: 'https://case.example', fetchImpl: fetchImpl as typeof fetch, ...overrides }
  return { config, calls, failOnce: () => (failNext = true) }
}

beforeEach(() => {
  clearCasePackageCache()
  clearFrameworkPackageIdCache()
})

test('concurrent cold requests for one package share a single upstream fetch', async () => {
  const { config, calls } = countingConfig()
  const results = await Promise.all(Array.from({ length: 20 }, () => getCFPackage(config, 'pkg-0')))
  assert.equal(calls.packages, 1)
  assert.ok(results.every((pkg) => pkg === results[0]), 'every caller gets the same object')
})

test('a failed fetch is shared by its waiters but not remembered', async () => {
  const { config, calls, failOnce } = countingConfig()
  failOnce()
  const results = await Promise.allSettled([getCFPackage(config, 'pkg-0'), getCFPackage(config, 'pkg-0')])
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected'])
  assert.ok(await getCFPackage(config, 'pkg-0'), 'the next request retries')
  assert.equal(calls.packages, 1, 'the 503 is not counted; the retry is')
})

test('maxCachedPackages sizes the cache; the default of 12 thrashes on 14', async () => {
  const ids = DOCUMENTS.map((d) => d.identifier)

  const small = countingConfig()
  for (const id of ids) await getCFPackage(small.config, id)
  for (const id of ids) await getCFPackage(small.config, id)
  assert.ok(small.calls.packages > ids.length, 'default cap evicts some of the 14')

  clearCasePackageCache()
  const large = countingConfig({ maxCachedPackages: 20 })
  for (const id of ids) await getCFPackage(large.config, id)
  for (const id of ids) await getCFPackage(large.config, id)
  assert.equal(large.calls.packages, ids.length, 'a warm second pass makes no upstream requests')
})

test('unknown framework titles resolve against one shared listing', async () => {
  const { config, calls } = countingConfig()
  const bogus = Array.from({ length: 500 }, (_, i) => `No Such Framework ${i}`)
  const results = await Promise.allSettled(bogus.map((title) => resolveFrameworkPackageId(config, title)))
  assert.ok(results.every((r) => r.status === 'rejected' && /no CASE framework found/.test(String(r.reason))))
  assert.equal(calls.documents, 1)

  // Known titles come out of the same listing.
  assert.equal(await resolveFrameworkPackageId(config, 'Framework 3'), 'pkg-3')
  assert.equal(calls.documents, 1)
})

test('a failed listing fetch is not cached', async () => {
  const { config, calls, failOnce } = countingConfig()
  failOnce()
  await assert.rejects(resolveFrameworkPackageId(config, 'Framework 1'))
  assert.equal(await resolveFrameworkPackageId(config, 'Framework 1'), 'pkg-1')
  assert.equal(calls.documents, 1)
})
