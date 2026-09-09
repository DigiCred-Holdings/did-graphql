#!/usr/bin/env -S npx tsx
/**
 * A sample GraphQL server application for CASE data — this repo's
 * reference for what "point did-graphql-server's case module at a real
 * go-case server" looks like end-to-end: composeModules([caseModule()])
 * wired into a real http.createServer(...), with a built-in GraphiQL
 * explorer and every one of the module's own default queries already
 * registered as this demo capability's allowedAction — so you can
 * browse frameworks, item types, and items (with their extensions)
 * immediately, against whichever go-case server you point it at.
 *
 * Still unsafeMode against did-graphql-server's own gate. But when
 * CONTROLLER_SEED is set, the
 * capability's own Data Integrity proof IS really, cryptographically
 * verified per request, locally, via Credo/Askar — see
 * verifyRequestCapability.ts. That's a genuine extra check on top of
 * (not a replacement for) did-graphql-server's own allowedAction
 * gating, which keeps running exactly as configured either way.
 *
 * Config:
 *   CASE_SERVER_URL      REQUIRED — base URL of the go-case server to query. There is no default: this example ships with no server of its own to point at, so bring your own (a local go-case run, or any instance you have access to).
 *   CASE_SERVER_API_KEY  sent as Authorization: Bearer <key> — go-case's own read routes need no auth (verified against its source), some deployments front it with one anyway
 *   CONTROLLER_SEED      if set, the demo capability is signed for real (eddsa-jcs-2022, via a did:key deterministically derived from this seed with Askar) instead of the unsigned placeholder — see controllerCapability.ts
 *   PORT                 default 4321
 *
 * Usage:
 *   CASE_SERVER_URL=https://your-go-case-instance npx tsx examples/case-manager/server.ts
 *   CASE_SERVER_URL=... CASE_SERVER_API_KEY=... npx tsx examples/case-manager/server.ts
 *   CASE_SERVER_URL=... CONTROLLER_SEED=any-string-you-like npx tsx examples/case-manager/server.ts
 */

import http from 'node:http'
import { buildSchema, graphql } from 'graphql'

import { encodeInvocationHeader } from '../../client/src/zcap.js'
import {
  attachResolvers,
  CASE_DEFAULT_QUERIES,
  caseModule,
  composeModules,
  checkIntrospection,
  configureZcap,
  decodeInvocationHeader,
} from '../../server/src/index.js'
import { createTestAgent } from '../../test/helpers/credoAgent.js'
import { buildDemoCapability } from './controllerCapability.js'
import { renderGraphiQLPage } from './graphiql.js'
import { verifyRequestCapability } from './verifyRequestCapability.js'

const PORT = process.env['PORT'] ? Number(process.env['PORT']) : 4321
const GRAPHQL_ENDPOINT = `http://localhost:${PORT}/graphql`

// No default server: whichever go-case instance you have is the one
// this should talk to, and a wrong-but-present default would fail as a
// confusing 404 on the first query instead of here.
const CASE_SERVER_URL = process.env['CASE_SERVER_URL']
if (!CASE_SERVER_URL) {
  console.error(
    'CASE_SERVER_URL is required — the base URL of a go-case server to query, e.g.\n' +
      '  CASE_SERVER_URL=https://your-go-case-instance npx tsx examples/case-manager/server.ts\n' +
      'See examples/case-manager/README.md.',
  )
  process.exit(1)
}

// No default package on purpose. CaseConfig.packageId exists for a
// server that reads one framework by default, which this example is
// not: it is a browser, and you cannot know an id before listing
// `case { cfDocuments }` — which needs the server already running.
// Queries here name their own framework or packageId, and one giving
// neither fails with PACKAGE_ID_REQUIRED saying exactly that.
const caseConfig = {
  baseUrl: CASE_SERVER_URL,
  apiKey: process.env['CASE_SERVER_API_KEY'] || undefined,
}

const composed = composeModules([caseModule()])
const schema = buildSchema(composed.sdl)
attachResolvers(schema, composed.resolvers)

const zcapConfig = configureZcap({
  unsafeMode: true,
  trust: { trustedRootController: 'did:example:demo' },
})

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// A browser-based caller on its own dev-server origin is a different
// origin from this one — real CORS, not optional. `*` is fine here:
// this is a local sample app with a synthetic demo capability, not a
// deployment guarding real data.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-zcap-invocation',
}

async function main() {
  // One agent for the whole process: signs the demo capability once
  // here at startup (if CONTROLLER_SEED is set), then verifies
  // incoming capabilities' real signatures per request throughout the
  // server's lifetime (verifyRequestCapability.ts) — nothing
  // persisted to disk, an in-memory Askar store is enough since
  // CONTROLLER_SEED re-derives the same key deterministically anyway.
  const agent = await createTestAgent()

  // Every one of the case module's own default queries — the module's
  // full case-management surface (case.cfDocuments/cfDocument/cfPackage/
  // cfItem/cfItemTypes/cfItems) is explorable immediately, not just one
  // or two hand-picked examples. See the package README's attenuation
  // rules: a query that's a field-SUBSET of any of these is also
  // allowed automatically — since every cf* field now lives under the
  // same root field (`case`), any combination of them a client asks
  // for is a subset as long as it doesn't request a field none of
  // these default queries already select.
  const { capability, controllerDid } = await buildDemoCapability(agent, {
    invocationTarget: GRAPHQL_ENDPOINT,
    allowedAction: CASE_DEFAULT_QUERIES,
    controllerSeed: process.env['CONTROLLER_SEED'],
  })
  const zcapHeader = encodeInvocationHeader({ chain: [capability] })

  const server = http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'GET' && req.url === '/graphql') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(renderGraphiQLPage({ headerValue: zcapHeader, defaultQuery: CASE_DEFAULT_QUERIES[0]! }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/graphql') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'POST /graphql only' }))
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid JSON body' }))
      return
    }

    // `null`, `"str"`, `7` and `[]` are all valid JSON, and reading a
    // property off the first of those throws — so narrow to an object
    // before touching it, then check `query` itself: `{}` yields
    // undefined, `{"query": 7}` a number, and everything downstream
    // (the introspection precheck, graphql's parse) wants a string.
    const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
      query?: unknown
      variables?: Record<string, unknown>
    }
    if (typeof body.query !== 'string' || body.query.trim() === '') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'body.query must be a non-empty string' }))
      return
    }
    const query: string = body.query

    const payload = decodeInvocationHeader(req.headers['x-zcap-invocation'] as string | undefined)

    // Real, local, additional check — did-graphql-server's own
    // allowedAction/expiry gate below still runs regardless; this is
    // the signature check unsafeMode alone never does.
    const verification = await verifyRequestCapability(agent, payload)
    if (!verification.ok) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ errors: [{ message: verification.reason, extensions: { code: 'CAPABILITY_INVALID' } }], data: null }))
      return
    }

    // Schema introspection reaches no gated resolver — __schema/__type
    // are graphql-js built-ins — so without this a capability-less
    // request could read the whole schema. Default policy accepts any
    // structurally valid chain (which unsafeMode's own check is), so
    // the GraphiQL page above keeps working.
    const introspection = checkIntrospection(zcapConfig, payload, query)
    if (!introspection.ok) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ errors: [{ message: introspection.message, extensions: { code: introspection.code } }], data: null }))
      return
    }

    const result = await graphql({
      schema,
      source: query,
      variableValues: body.variables,
      contextValue: { zcapConfig, payload, rawQuery: query, caseConfig },
    })

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  })

  server.listen(PORT, () => {
    console.log(`case-manager listening on ${GRAPHQL_ENDPOINT}`)
    console.log(`CASE server: ${caseConfig.baseUrl}${caseConfig.apiKey ? ' (API key set)' : ''}`)
    console.log(
      controllerDid
        ? `Controller: ${controllerDid} (real eddsa-jcs-2022-signed capability, derived from CONTROLLER_SEED — verified for real, per request, via Credo/Askar)`
        : 'Controller: did:example:demo (unsigned placeholder — set CONTROLLER_SEED for a real signed + really-verified capability)',
    )
    console.log(
      '[UNSAFE_MODE] did-graphql-server\'s own allowedAction/expiry gate still skips signature verification — see the package README before using this pattern anywhere real.\n',
    )
    console.log(
      'No default package: every query names its own framework or packageId, and one giving neither fails with PACKAGE_ID_REQUIRED. Start with case { cfDocuments { items { identifier title } } } to see what this server hosts.',
    )
    console.log(
      `Open ${GRAPHQL_ENDPOINT} in a browser for a GraphiQL explorer — the x-zcap-invocation header and a default query are pre-filled, so it works immediately. Try case.cfDocuments first to see what frameworks exist on this server, then case.cfItemTypes/cfItems with a framework title you find there.`,
    )
  })

  const shutdown = () => {
    server.close()
    void agent.shutdown().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
