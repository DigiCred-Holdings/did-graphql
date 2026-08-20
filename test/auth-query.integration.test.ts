import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSchema, graphql } from 'graphql'

import { AUTH_QUERY as CLIENT_AUTH_QUERY } from '../client/src/types.js'
import { encodeInvocationHeader } from '../client/src/zcap.js'
import {
  AUTH_QUERY,
  attachResolvers,
  authModule,
  composeModules,
  configureZcap,
  decodeInvocationHeader,
} from '../server/src/index.js'
import { plain } from './helpers/plain.js'
import { GRAPHQL_ENDPOINT } from './helpers/zcapFixtures.js'

const unsafeConfig = configureZcap({
  unsafeMode: true,
  trust: { trustedRootController: 'did:key:z6Mkplaceholder', expectedInvocationTarget: GRAPHQL_ENDPOINT },
})

const composed = composeModules([authModule])

const leaf = {
  id: 'urn:zcap:test',
  controller: 'did:key:z6Mkholder',
  invocationTarget: GRAPHQL_ENDPOINT,
  allowedAction: composed.defaultQueries,
  expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  proof: { type: 'DataIntegrityProof', verificationMethod: 'did:key:z6Mkissuer#z6Mkissuer' },
}

function schemaWithAuth() {
  const schema = buildSchema(composed.sdl)
  attachResolvers(schema, composed.resolvers)
  return schema
}

test('client and server share the same AUTH_QUERY', () => {
  assert.equal(AUTH_QUERY, CLIENT_AUTH_QUERY)
  assert.equal(authModule.defaultQueries[0], AUTH_QUERY)
})

test('composed authModule resolves query Auth { zcap { valid } }', async () => {
  const payload = decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf] }))
  const result = await graphql({
    schema: schemaWithAuth(),
    source: AUTH_QUERY,
    contextValue: { zcapConfig: unsafeConfig, payload },
  })
  assert.equal(result.errors, undefined)
  assert.deepEqual(plain(result.data), { zcap: { valid: true } })
})

test('Query.zcap echoes leaf fields when selected', async () => {
  const payload = decodeInvocationHeader(encodeInvocationHeader({ chain: [leaf] }))
  const result = await graphql({
    schema: schemaWithAuth(),
    source: 'query Auth { zcap { valid controller invocationTarget allowedAction } }',
    contextValue: { zcapConfig: unsafeConfig, payload },
  })
  assert.equal(result.errors, undefined)
  assert.deepEqual(plain(result.data), {
    zcap: {
      valid: true,
      controller: leaf.controller,
      invocationTarget: leaf.invocationTarget,
      allowedAction: leaf.allowedAction,
    },
  })
})
