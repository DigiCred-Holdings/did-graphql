import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GraphQLScalarType } from 'graphql'

import {
  authModule,
  caseModule,
  composeModules,
  mergeResolvers,
  ResolverCollisionError,
  type GraphqlModule,
} from '../server/src/index.js'

test('the real modules compose without collision', () => {
  const composed = composeModules([authModule, caseModule()])
  assert.deepEqual(Object.keys(composed.resolvers).sort(), ['AuthQueries', 'CFAssociationEndpoint', 'CaseQueries', 'JSON', 'Query'])
  assert.equal(typeof (composed.resolvers['Query'] as Record<string, unknown>)['auth'], 'function')
  assert.equal(typeof (composed.resolvers['Query'] as Record<string, unknown>)['case'], 'function')
})

test('the JSON scalar survives the merge as a real GraphQLScalarType instance', () => {
  const composed = composeModules([authModule, caseModule()])
  assert.ok(composed.resolvers['JSON'] instanceof GraphQLScalarType)
})

test('composeModules refuses a module that redeclares another module type+field', () => {
  const rogue: GraphqlModule = {
    name: 'rogue',
    typeDefs: '',
    queryFields: '',
    defaultQueries: [],
    resolvers: { CaseQueries: { cfItemTypes: () => [] } },
  }
  assert.throws(
    () => composeModules([authModule, caseModule(), rogue]),
    (err: unknown) => {
      assert.ok(err instanceof ResolverCollisionError)
      assert.match((err as Error).message, /module 'rogue' redeclares CaseQueries\.cfItemTypes, already provided by module 'case'/)
      return true
    },
  )
})

test('composeModules refuses a second custom scalar of the same name', () => {
  const rogue: GraphqlModule = {
    name: 'rogue',
    typeDefs: '',
    queryFields: '',
    defaultQueries: [],
    resolvers: { JSON: new GraphQLScalarType({ name: 'JSON' }) },
  }
  assert.throws(() => composeModules([caseModule(), rogue]), /redeclares the custom scalar JSON/)
})

test('mergeResolvers merges disjoint maps', () => {
  const merged = mergeResolvers(
    { Query: { a: () => 1 } },
    { Query: { b: () => 2 }, Other: { c: () => 3 } },
  )
  assert.deepEqual(Object.keys(merged).sort(), ['Other', 'Query'])
  assert.deepEqual(Object.keys(merged['Query'] as object).sort(), ['a', 'b'])
})

test('mergeResolvers refuses a host map that shadows a module resolver — the gated-field footgun', () => {
  const composed = composeModules([authModule, caseModule()])
  assert.throws(
    () => mergeResolvers(composed.resolvers, { CaseQueries: { cfItemTypes: () => [{ itemType: 'shadowed', count: 0 }] } }),
    (err: unknown) => {
      assert.ok(err instanceof ResolverCollisionError)
      assert.match((err as Error).message, /map #2 redeclares CaseQueries\.cfItemTypes/)
      assert.match((err as Error).message, /can drop an authorization check/)
      return true
    },
  )
})

test('mergeResolvers refuses shadowing a namespace marker — one field that ungates everything under it', () => {
  const composed = composeModules([authModule, caseModule()])
  assert.throws(
    () => mergeResolvers(composed.resolvers, { Query: { case: () => ({}) } }),
    /redeclares Query\.case/,
  )
})

test('mergeResolvers labels sources when given labels', () => {
  assert.throws(
    () =>
      mergeResolvers(
        { label: 'library', resolvers: { Query: { x: () => 1 } } },
        { label: 'my server', resolvers: { Query: { x: () => 2 } } },
      ),
    /my server redeclares Query\.x, already provided by library/,
  )
})

test('a host adding its own distinct fields to a module type still works', () => {
  const composed = composeModules([authModule, caseModule()])
  const merged = mergeResolvers(composed.resolvers, { Query: { myOwnField: () => 'fine' } })
  assert.equal(typeof (merged['Query'] as Record<string, unknown>)['myOwnField'], 'function')
  assert.equal(typeof (merged['Query'] as Record<string, unknown>)['case'], 'function')
})
