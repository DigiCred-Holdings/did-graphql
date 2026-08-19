#!/usr/bin/env -S npx tsx
/**
 * A sample GraphQL server application for CASE data — this repo's
 * reference for what "point did-graphql-server's case module at a real
 * go-case server" looks like end-to-end: composeModules([caseModule()])
 * wired into a real http.createServer(...), with a built-in GraphiQL
 * explorer and every one of the module's own default queries already
 * registered as this demo capability's allowedAction — so you can
 * browse frameworks, item types, and items (with their extensions)
 * immediately, against any go-case server you point it at.
 *
 * Still unsafeMode against did-graphql-server's own gate — no live
 * ACA-Py agent here for that. But when CONTROLLER_SEED is set, the
 * capability's own Data Integrity proof IS really, cryptographically
 * verified per request, locally, via Credo/Askar — see
 * verifyRequestCapability.ts. That's a genuine extra check on top of
 * (not a replacement for) did-graphql-server's own allowedAction
 * gating, which keeps running exactly as configured either way.
 *
 * Config (all optional — defaults point at the real go-case sandbox
 * this repo has been developed against):
 *   CASE_SERVER_URL      go-case base URL
 *   CASE_SERVER_API_KEY  sent as Authorization: Bearer <key> — go-case's own read routes need no auth (verified against its source), some deployments front it with one anyway
 *   CASE_PACKAGE_ID      this deployment's default package — only matters for a query that omits both packageId and framework
 *   CONTROLLER_SEED      if set, the demo capability is signed for real (eddsa-jcs-2022, via a did:key deterministically derived from this seed with Askar) instead of the unsigned placeholder — see controllerCapability.ts
 *   PORT                 default 4321
 *
 * Usage:
 *   npx tsx examples/case-manager/server.ts
 *   CASE_SERVER_URL=https://your-go-case-instance CASE_SERVER_API_KEY=... npx tsx examples/case-manager/server.ts
 *   CONTROLLER_SEED=any-string-you-like npx tsx examples/case-manager/server.ts
 */

import http from 'node:http'
import { buildSchema, graphql } from 'graphql'

import { encodeInvocationHeader } from '../../client/src/zcap.js'
import {
  attachResolvers,
  CASE_DEFAULT_QUERIES,
  caseModule,
  composeModules,
  configureZcap,
  decodeInvocationHeader,
} from '../../server/src/index.js'
import { createTestAgent } from '../../test/helpers/credoAgent.js'
import { buildDemoCapability } from './controllerCapability.js'
import { renderGraphiQLPage } from './graphiql.js'
import { verifyRequestCapability } from './verifyRequestCapability.js'

const PORT = process.env['PORT'] ? Number(process.env['PORT']) : 4321
const GRAPHQL_ENDPOINT = `http://localhost:${PORT}/graphql`

const caseConfig = {
  baseUrl: process.env['CASE_SERVER_URL'] ?? 'https://go-case-digicred-sandbox.up.railway.app',
  packageId: process.env['CASE_PACKAGE_ID'] ?? 'd27a0443-8155-530c-8858-6011014101df', // Wyoming Higher Education
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

// A browser-based caller (e.g. companion-app's GraphQL Workflow
// Sandbox, running on its own dev-server origin) is a different
// origin from this one — real CORS, not optional, same as
// catalog-graphql's own server.ts. `*` is fine here: this is a local
// sample app with a synthetic demo capability, not a deployment
// guarding real data.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-zcap-invocation',
}

async function main() {
  // One agent for the whole process: signs the demo capability once
  // here at startup (if CONTROLLER_SEED is set), then verifies
  // incoming capabilities' real signatures per request throughout the
  // server's lifetime (verifyRequestCapability.ts) — no wallet
  // persisted to disk, an in-memory Askar store is enough since
  // CONTROLLER_SEED re-derives the same key deterministically anyway.
  const agent = await createTestAgent()

  // Every one of the case module's own default queries — the module's
  // full case-management surface (cfDocuments/cfDocument/cfPackage/
  // cfItem/cfItemTypes/cfItems) is explorable immediately, not just one
  // or two hand-picked examples. See the package README's attenuation
  // rules: a query that's a field-SUBSET of any of these is also
  // allowed automatically — only a genuinely different root field, or
  // extra fields these don't already select, gets rejected.
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

    let body: { query: string; variables?: Record<string, unknown> }
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid JSON body' }))
      return
    }

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

    const result = await graphql({
      schema,
      source: body.query,
      variableValues: body.variables,
      contextValue: { zcapConfig, payload, rawQuery: body.query, caseConfig },
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
      '[UNSAFE_MODE] did-graphql-server\'s own allowedAction/expiry gate still skips agent verification (no live ACA-Py agent here) — see the package README before using this pattern anywhere real.\n',
    )
    console.log(
      `Open ${GRAPHQL_ENDPOINT} in a browser for a GraphiQL explorer — the x-zcap-invocation header and a default query are pre-filled, so it works immediately. Try cfDocuments first to see what frameworks exist on this server, then cfItemTypes/cfItems with a framework title you find there.`,
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
