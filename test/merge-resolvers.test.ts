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

// --- review findings: labeled-entry detection and type-kind collisions ---

test('a plain map with GraphQL types named `label`/`resolvers` is not mistaken for a labeled entry', () => {
  const plain = { label: { a: () => 1 }, resolvers: { b: () => 2 } }
  const merged = mergeResolvers(plain, { Other: { c: () => 3 } })
  // Read as type names, not as a { label, resolvers } wrapper.
  assert.deepEqual(Object.keys(merged).sort(), ['Other', 'label', 'resolvers'])
  assert.equal(typeof (merged['label'] as Record<string, unknown>)['a'], 'function')
})

test('a labeled entry still needs a string label to be treated as one', () => {
  // `label` present but not a string -> plain map.
  const merged = mergeResolvers({ label: { a: () => 1 } }, { resolvers: { b: () => 2 } })
  assert.deepEqual(Object.keys(merged).sort(), ['label', 'resolvers'])
})

test('declaring a type as a custom scalar after field resolvers throws instead of replacing them', () => {
  assert.throws(
    () => mergeResolvers({ Thing: { a: () => 1 } }, { Thing: new GraphQLScalarType({ name: 'Thing' }) }),
    (err: unknown) => {
      assert.ok(err instanceof ResolverCollisionError)
      assert.match((err as Error).message, /declares Thing as a custom scalar, but map #1 already declared field resolvers on it/)
      return true
    },
  )
})

test('declaring field resolvers on a type already merged as a custom scalar throws too', () => {
  assert.throws(
    () => mergeResolvers({ JSON: new GraphQLScalarType({ name: 'JSON' }) }, { JSON: { a: () => 1 } }),
    (err: unknown) => {
      assert.ok(err instanceof ResolverCollisionError)
      assert.match((err as Error).message, /declares field resolvers on JSON, but map #1 already declared it as a custom scalar/)
      return true
    },
  )
})

test('a real module scalar cannot be replaced by a host field map, in either order', () => {
  const composed = composeModules([authModule, caseModule()])
  assert.throws(() => mergeResolvers(composed.resolvers, { JSON: { serialize: () => 1 } }), ResolverCollisionError)
  assert.throws(() => mergeResolvers({ JSON: { serialize: () => 1 } }, composed.resolvers), ResolverCollisionError)
})
