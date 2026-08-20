import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSchema, graphql } from 'graphql'

import { encodeInvocationHeader } from '../client/src/zcap.js'
import {
  attachResolvers,
  CASE_DEFAULT_QUERIES,
  caseModule,
  clearCasePackageCache,
  composeModules,
  configureZcap,
  decodeInvocationHeader,
} from '../server/src/index.js'
import { plain } from './helpers/plain.js'
import { GRAPHQL_ENDPOINT } from './helpers/zcapFixtures.js'

const DOCUMENTS_QUERY = CASE_DEFAULT_QUERIES[0]!
const ITEMS_QUERY = CASE_DEFAULT_QUERIES.find((q) => q.includes('cfItems('))!

const unsafeConfig = configureZcap({
  unsafeMode: true,
  trust: { trustedRootController: 'did:key:z6Mkplaceholder', expectedInvocationTarget: GRAPHQL_ENDPOINT },
})

const composed = composeModules([caseModule()])

const MOCK_ITEMS = [
  { identifier: 'item-1', CFItemType: 'Program', fullStatement: 'Program One' },
  { identifier: 'item-2', CFItemType: 'Program', fullStatement: 'Program Two' },
  { identifier: 'item-3', CFItemType: 'College', fullStatement: 'Demo College' },
]

function mockFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input)
  if (url.includes('/CFDocuments') && !/CFDocuments\/[^/?]+/.test(url)) {
    return Promise.resolve(
      new Response(JSON.stringify({ CFDocuments: [{ identifier: 'pkg-1', uri: 'https://case.example/pkg-1', title: 'Demo Framework' }] }), {
        headers: { 'content-type': 'application/json', 'x-total-count': '1' },
      }),
    )
  }
  if (url.includes('/CFPackages/pkg-1')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          CFDocument: { identifier: 'pkg-1', uri: 'https://case.example/pkg-1', title: 'Demo Framework' },
          CFItems: MOCK_ITEMS,
          CFAssociations: [],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
  }
  return Promise.resolve(new Response('not found', { status: 404 }))
}

const caseConfig = {
  baseUrl: 'https://case.example',
  packageId: 'pkg-1',
  fetchImpl: mockFetch as typeof fetch,
}

const leaf = {
  id: 'urn:zcap:test',
  controller: 'did:key:z6Mkholder',
  invocationTarget: GRAPHQL_ENDPOINT,
  allowedAction: [DOCUMENTS_QUERY, ITEMS_QUERY],
  expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  proof: { type: 'DataIntegrityProof', verificationMethod: 'did:key:z6Mkissuer#z6Mkissuer' },
}

function schemaWithCase() {
  const schema = buildSchema(composed.sdl)
  attachResolvers(schema, composed.resolvers)
  return schema
}

test('CASE module defaultQueries include cfDocuments', () => {
  assert.ok(CASE_DEFAULT_QUERIES.some((q) => q.includes('cfDocuments')))
})

test('unsafe cfDocuments is allowed when the document is in allowedAction', async () => {
  clearCasePackageCache()
  const payload = decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf] }))
  const result = await graphql({
    schema: schemaWithCase(),
    source: DOCUMENTS_QUERY,
    contextValue: { zcapConfig: unsafeConfig, payload, rawQuery: DOCUMENTS_QUERY, caseConfig },
  })
  assert.equal(result.errors, undefined)
  assert.deepEqual(plain(result.data), {
    cfDocuments: {
      items: [{ identifier: 'pkg-1', title: 'Demo Framework', description: null, frameworkType: null, publisher: null, version: null }],
      totalCount: 1,
    },
  })
})

test('unsafe cfDocuments allows a field-subset of the registered document (real attenuation)', async () => {
  // A query asking for FEWER fields than what's registered in
  // allowedAction (here just `totalCount`, dropping `items`) is
  // allowed by design — see did-graphql-server's field-subset
  // attenuation (matchesAllowedAction), not exact-string matching.
  // This used to be (wrongly) asserted as a rejection; keeping it as
  // its own passing test documents the intended behavior instead of
  // silently losing the coverage.
  clearCasePackageCache()
  const subset = 'query CFDocuments { cfDocuments { totalCount } }'
  const payload = decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf] }))
  const result = await graphql({
    schema: schemaWithCase(),
    source: subset,
    contextValue: { zcapConfig: unsafeConfig, payload, rawQuery: subset, caseConfig },
  })
  assert.equal(result.errors, undefined)
  assert.deepEqual(plain(result.data), { cfDocuments: { totalCount: 1 } })
})

test('unsafe cfItem is rejected — no allowedAction entry selects that root field at all', async () => {
  const other = 'query Item($id: ID!) { cfItem(id: $id) { identifier } }'
  const payload = decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf] }))
  const result = await graphql({
    schema: schemaWithCase(),
    source: other,
    variableValues: { id: 'item-1' },
    contextValue: { zcapConfig: unsafeConfig, payload, rawQuery: other, caseConfig },
  })
  assert.ok(result.errors?.length)
  assert.equal(result.errors?.[0]?.extensions?.code, 'QUERY_NOT_ALLOWED')
})

test('cfItems with no itemType returns every item in the package', async () => {
  clearCasePackageCache()
  const payload = decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf] }))
  const result = await graphql({
    schema: schemaWithCase(),
    source: ITEMS_QUERY,
    variableValues: { packageId: 'pkg-1' },
    contextValue: { zcapConfig: unsafeConfig, payload, rawQuery: ITEMS_QUERY, caseConfig },
  })
  assert.equal(result.errors, undefined)
  const data = plain(result.data) as { cfItems: { totalCount: number; items: { identifier: string }[] } }
  assert.equal(data.cfItems.totalCount, 3)
  assert.deepEqual(
    data.cfItems.items.map((i) => i.identifier),
    ['item-1', 'item-2', 'item-3'],
  )
})

test('cfItems(itemType) filters server-side before pagination, and totalCount reflects the filtered count', async () => {
  clearCasePackageCache()
  const payload = decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf] }))
  const result = await graphql({
    schema: schemaWithCase(),
    source: ITEMS_QUERY,
    variableValues: { packageId: 'pkg-1', itemType: 'Program' },
    contextValue: { zcapConfig: unsafeConfig, payload, rawQuery: ITEMS_QUERY, caseConfig },
  })
  assert.equal(result.errors, undefined)
  const data = plain(result.data) as { cfItems: { totalCount: number; items: { identifier: string; CFItemType: string }[] } }
  assert.equal(data.cfItems.totalCount, 2)
  assert.deepEqual(
    data.cfItems.items.map((i) => i.identifier),
    ['item-1', 'item-2'],
  )
  assert.ok(data.cfItems.items.every((i) => i.CFItemType === 'Program'))
})
