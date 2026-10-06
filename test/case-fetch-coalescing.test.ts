// Upstream request counts for the CASE client under concurrency and
// many-framework queries (did-graphql#53):
// - concurrent cold requests for one package share one fetch
// - the package cache cap is configurable
// - unknown framework titles don't each re-fetch the CFDocuments listing
// - none of the above shares a response across apiKeys

import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

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

// Fronted by a key: only `Bearer good` reads anything.
function keyedFetch() {
  const calls = { packages: 0, documents: 0 }
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    if (auth !== 'Bearer good') return new Response('unauthorized', { status: 401 })
    if (url.includes('/CFDocuments')) {
      calls.documents++
      return Response.json({ CFDocuments: DOCUMENTS })
    }
    calls.packages++
    return Response.json({ CFDocument: { identifier: 'pkg-0', uri: '', title: 'pkg-0' }, CFItems: [], CFAssociations: [] })
  }
  const config = (apiKey: string): CaseConfig => ({
    baseUrl: 'https://case.example',
    apiKey,
    fetchImpl: fetchImpl as typeof fetch,
  })
  return { good: config('good'), bad: config('bad'), calls }
}

test('package fetches and cache entries are not shared across apiKeys', async () => {
  const { good, bad } = keyedFetch()

  // Cold, concurrent, bad key first: neither inherits the other's outcome.
  const [badResult, goodResult] = await Promise.allSettled([getCFPackage(bad, 'pkg-0'), getCFPackage(good, 'pkg-0')])
  assert.equal(badResult.status, 'rejected')
  assert.equal(goodResult.status, 'fulfilled')

  // Warm: the good key's cached package isn't served to the bad key.
  await assert.rejects(getCFPackage(bad, 'pkg-0'), /401/)
})

test('framework listings and title resolutions are not shared across apiKeys', async () => {
  const { good, bad } = keyedFetch()

  const [badResult, goodResult] = await Promise.allSettled([
    resolveFrameworkPackageId(bad, 'Framework 2'),
    resolveFrameworkPackageId(good, 'Framework 2'),
  ])
  assert.equal(badResult.status, 'rejected')
  assert.equal(goodResult.status, 'fulfilled')

  // Neither the resolved title nor the good key's listing reaches the bad key.
  await assert.rejects(resolveFrameworkPackageId(bad, 'Framework 2'), /401/)
  await assert.rejects(resolveFrameworkPackageId(bad, 'Framework 5'), /401/)
})

test('a listing fetch slower than the TTL is still shared, and fresh once it lands', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let documents = 0
  const config: CaseConfig = {
    baseUrl: 'https://case.example',
    fetchImpl: (async () => {
      documents++
      await gate
      return Response.json({ CFDocuments: DOCUMENTS })
    }) as typeof fetch,
  }

  mock.timers.enable({ apis: ['Date'], now: 0 })
  t.after(() => mock.timers.reset())

  const first = resolveFrameworkPackageId(config, 'Framework 1')
  mock.timers.tick(31_000) // past the 30s listing TTL, fetch still pending
  const second = resolveFrameworkPackageId(config, 'Framework 2')
  release()
  assert.deepEqual(await Promise.all([first, second]), ['pkg-1', 'pkg-2'])
  assert.equal(documents, 1, 'the second lookup joined the pending fetch')

  // The freshness window starts on arrival, not when the fetch began.
  mock.timers.tick(20_000)
  assert.equal(await resolveFrameworkPackageId(config, 'Framework 3'), 'pkg-3')
  assert.equal(documents, 1)
})

// Each upstream call waits on its own gate, so a test controls the order responses land in.
function gatedFetch(respond: (call: number) => unknown) {
  const gates: Array<() => void> = []
  let calls = 0
  const fetchImpl = (async () => {
    const call = calls++
    await new Promise<void>((resolve) => (gates[call] = resolve))
    return Response.json(respond(call))
  }) as typeof fetch
  const started = async (n: number) => {
    while (calls < n) await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return { config: { baseUrl: 'https://case.example', fetchImpl } as CaseConfig, gates, started }
}

test('a listing fetch started before a clear does not overwrite the one after it', async () => {
  const fresh = [...DOCUMENTS, { identifier: 'pkg-new', uri: '', title: 'Only In Fresh' }]
  const { config, gates, started } = gatedFetch((call) => ({ CFDocuments: call === 0 ? DOCUMENTS : fresh }))

  const stale = resolveFrameworkPackageId(config, 'Framework 0')
  await started(1)
  clearFrameworkPackageIdCache()
  const current = resolveFrameworkPackageId(config, 'Framework 1')
  await started(2)

  gates[1]!() // post-clear fetch lands first
  assert.equal(await current, 'pkg-1')
  gates[0]!() // pre-clear fetch lands last
  assert.equal(await stale, 'pkg-0')

  assert.equal(await resolveFrameworkPackageId(config, 'Only In Fresh'), 'pkg-new')
})

test('a package fetch started before a clear does not overwrite the one after it', async () => {
  const pkg = (version: string) => ({ CFDocument: { identifier: 'pkg-0', uri: '', title: version }, CFItems: [], CFAssociations: [] })
  const { config, gates, started } = gatedFetch((call) => pkg(call === 0 ? 'old' : 'new'))

  const stale = getCFPackage(config, 'pkg-0')
  await started(1)
  clearCasePackageCache()
  const current = getCFPackage(config, 'pkg-0')
  await started(2)

  gates[1]!()
  assert.equal((await current)?.CFDocument.title, 'new')
  gates[0]!()
  assert.equal((await stale)?.CFDocument.title, 'old')

  assert.equal((await getCFPackage(config, 'pkg-0'))?.CFDocument.title, 'new')
})

// The first upstream call never settles (and ignores its abort signal);
// every later one answers normally.
function stallFirst(respond: (url: string) => Response) {
  let calls = 0
  const fetchImpl = (async (input: string | URL | Request) => {
    if (calls++ === 0) return new Promise<Response>(() => {})
    return respond(String(input))
  }) as typeof fetch
  return { config: { baseUrl: 'https://case.example', fetchImpl, fetchTimeoutMs: 50 } as CaseConfig, calls: () => calls }
}

test('a stalled package fetch times out, and a later call succeeds', async () => {
  const { config, calls } = stallFirst(() =>
    Response.json({ CFDocument: { identifier: 'pkg-0', uri: '', title: 'pkg-0' }, CFItems: [], CFAssociations: [] }),
  )
  const results = await Promise.allSettled([getCFPackage(config, 'pkg-0'), getCFPackage(config, 'pkg-0')])
  for (const r of results) assert.match(String(r.status === 'rejected' && r.reason), /timed out after 50ms/)
  assert.equal(calls(), 1, 'both waited on the one shared fetch')

  assert.equal((await getCFPackage(config, 'pkg-0'))?.CFDocument.identifier, 'pkg-0')
  assert.equal(calls(), 2)
})

test('a stalled listing fetch times out, and a later lookup succeeds', async () => {
  const { config } = stallFirst(() => Response.json({ CFDocuments: DOCUMENTS }))
  await assert.rejects(resolveFrameworkPackageId(config, 'Framework 1'), /timed out/)
  assert.equal(await resolveFrameworkPackageId(config, 'Framework 1'), 'pkg-1')
})

test('titles past the first 1000 frameworks resolve', async () => {
  const all = Array.from({ length: 1500 }, (_, i) => ({ identifier: `pkg-${i}`, uri: '', title: `Framework ${i}` }))
  let requests = 0
  const config: CaseConfig = {
    baseUrl: 'https://case.example',
    fetchImpl: (async (input: string | URL | Request) => {
      requests++
      const params = new URL(String(input)).searchParams
      const offset = Number(params.get('offset') ?? 0)
      const limit = Number(params.get('limit') ?? all.length)
      return Response.json({ CFDocuments: all.slice(offset, offset + limit) }, { headers: { 'x-total-count': String(all.length) } })
    }) as typeof fetch,
  }
  assert.equal(await resolveFrameworkPackageId(config, 'Framework 1200'), 'pkg-1200')
  assert.equal(requests, 2)
})

test('maxCachedPackages ignores values that would unbound or zero the cache', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `pkg-${i}`)
  for (const cap of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
    clearCasePackageCache()
    const { config, calls } = countingConfig({ maxCachedPackages: cap })
    for (const id of ids) await getCFPackage(config, id)
    calls.packages = 0
    for (const id of ids.slice(-12)) await getCFPackage(config, id)
    await getCFPackage(config, ids[17]!) // 13th most recent: evicted under the default 12
    assert.equal(calls.packages, 1, `maxCachedPackages: ${cap} should behave as the default 12`)
  }

  clearCasePackageCache()
  const { config, calls } = countingConfig({ maxCachedPackages: 2.5 })
  for (const id of ids.slice(0, 3)) await getCFPackage(config, id)
  calls.packages = 0
  await getCFPackage(config, ids[0]!)
  assert.equal(calls.packages, 1, '2.5 rounds down to 2, so the oldest of three was evicted')
})
