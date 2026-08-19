#!/usr/bin/env -S npx tsx
/**
 * Demonstrates CFItem.extensions — the CASE 1.1 spec's free-form
 * extensibility mechanism — and, deliberately, the boundary this
 * package draws around it: the `case` module knows the *shape*
 * (`extensions: JSON`, a plain `Record<string, unknown>`) but nothing
 * about what's *inside* it. Namespace keys like `ext:ctdl`/
 * `ext:digicred` are one consumer's own convention (digicred-crms's
 * catalog-graphql), read out here only to show what real data looks
 * like — not something this module assumes or depends on.
 *
 * Runs a real query against the real go-case sandbox server, entirely
 * in-process (no HTTP server to start) — composeModules builds the
 * schema, a synthetic unsafeMode capability stands in for a real
 * wallet-signed one, and the CASE module's own resolvers do a real
 * network fetch against go-case.
 *
 * Usage: npx tsx examples/case-manager/run.ts
 */

import { buildSchema, graphql } from 'graphql'

import { encodeInvocationHeader } from '../../client/src/zcap.js'
import type { Capability } from '../../client/src/types.js'
import {
  attachResolvers,
  caseModule,
  composeModules,
  configureZcap,
  decodeInvocationHeader,
} from '../../server/src/index.js'

const GRAPHQL_ENDPOINT = 'https://example.invalid/graphql' // never actually dereferenced — see unsafeMode below
const FRAMEWORK = 'Wyoming Higher Education' // a real, live framework whose items all populate extensions (verified: 1058/1058)

const composed = composeModules([caseModule()])

function schema() {
  const built = buildSchema(composed.sdl)
  attachResolvers(built, composed.resolvers)
  return built
}

// unsafeMode: this demo isn't showing ZCAP signing (see the package
// README for that) — it's showing extensions. A synthetic,
// structurally-valid-but-unsigned capability lets the real
// requireAuthorizedQuery gate still run for real (allowedAction
// membership checked exactly as it would in production), without
// needing a live wallet/agent to sign anything.
const zcapConfig = configureZcap({
  unsafeMode: true,
  trust: { trustedRootController: 'did:example:demo' },
})

const QUERY = `
  query Items($framework: String, $limit: Int) {
    cfItems(framework: $framework, limit: $limit) {
      totalCount
      items {
        identifier
        CFItemType
        fullStatement
        extensions
      }
    }
  }
`

const capability: Capability = {
  id: 'urn:zcap:case-manager-demo',
  controller: 'did:example:demo',
  invocationTarget: GRAPHQL_ENDPOINT,
  allowedAction: [QUERY],
  expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  proof: { type: 'none', verificationMethod: 'did:example:demo#unsafe' },
}

/** Real ext:ctdl.type value (Place/Organization/LearningProgram, …) if this item's extensions happen to use that key — just for picking a varied, representative sample below, not something this module reads or assumes. */
function extCtdlType(item: Record<string, unknown>): string | undefined {
  const ext = item['extensions'] as Record<string, unknown> | null
  const ctdl = ext?.['ext:ctdl'] as Record<string, unknown> | undefined
  return typeof ctdl?.['type'] === 'string' ? (ctdl['type'] as string) : undefined
}

async function main() {
  const payload = decodeInvocationHeader(encodeInvocationHeader({ chain: [capability] }))

  console.log(`Querying "${FRAMEWORK}" (a real live go-case framework)...\n`)

  // A wider page than we'll print in full — just enough to reliably
  // catch a few genuinely different kinds of item (county, college,
  // program) in one request, since this framework's items happen to
  // be stored counties-then-institutions-then-programs.
  const result = await graphql({
    schema: schema(),
    source: QUERY,
    variableValues: { framework: FRAMEWORK, limit: 20 },
    contextValue: {
      zcapConfig,
      payload,
      rawQuery: QUERY,
      caseConfig: {
        baseUrl: 'https://go-case-digicred-sandbox.up.railway.app',
        packageId: '', // unused — this query resolves the package by `framework`, not this default
      },
    },
  })

  if (result.errors?.length) {
    console.error('Query failed:', result.errors.map((e) => e.message).join('; '))
    process.exitCode = 1
    return
  }

  const data = result.data as { cfItems: { totalCount: number; items: Record<string, unknown>[] } }
  console.log(`${data.cfItems.totalCount} items total in this framework.\n`)

  // One full example per distinct kind of item seen (by its own
  // ext:ctdl.type, purely for picking a varied sample) — printing all
  // 20 fetched would just repeat the same shape nine times for the
  // counties alone.
  const seenTypes = new Set<string>()
  for (const item of data.cfItems.items) {
    const kind = extCtdlType(item) ?? 'unknown'
    if (seenTypes.has(kind)) continue
    seenTypes.add(kind)

    console.log(`— ${item['fullStatement']}  (CFItemType: ${item['CFItemType']}, ext:ctdl.type: ${kind})`)
    const ext = item['extensions'] as Record<string, unknown> | null
    if (!ext || Object.keys(ext).length === 0) {
      console.log('  extensions: {} (empty — not every item populates this)\n')
      continue
    }
    console.log('  extensions:', JSON.stringify(ext, null, 2).split('\n').join('\n  '))
    console.log()
  }

  console.log(
    [
      'Notice what just happened: the case module\'s GraphQL schema declares',
      '`extensions: JSON` with no opinion about what\'s inside it — see',
      'server/src/case/schema.ts\'s doc comment, and CFItem.extensions\' type',
      'in client.ts (`Record<string, unknown>`, not a shape naming',
      '`ext:ctdl`/`ext:digicred` specifically). Those two namespace keys you',
      'just saw are real, but they\'re catalog-graphql\'s own convention for',
      'its own frameworks (see that service\'s caseData.ts) — a different',
      'CASE consumer\'s extensions could use entirely different keys, and',
      'this module would handle it exactly the same way: pass it through,',
      'unopinionated, as JSON.',
    ].join('\n'),
  )
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
