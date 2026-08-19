# case-manager

A tiny, standalone sample app demonstrating how `CFItem.extensions`
actually works — and, deliberately, what this package does and doesn't
know about it.

## Run it

```bash
npx tsx examples/case-manager/run.ts
```

No server to start, no credentials needed — it runs a real GraphQL
query against the real go-case sandbox server, entirely in-process:
`composeModules([caseModule()])` builds the schema, a synthetic
`unsafeMode` capability stands in for a real wallet-signed one (so the
real `allowedAction` gate still runs, just without needing a live
wallet/agent to sign anything — see the package README's `unsafeMode`
section), and the CASE module's own resolvers do a real network fetch.

## What it shows

`extensions: JSON` is the CASE 1.1 spec's own free-form extensibility
field — arbitrary per framework. This package's schema/types
(`server/src/case/schema.ts`, `client.ts`'s `CFItem` interface) declare
it as a plain `Record<string, unknown>` with **no** opinion about
what's inside it or what namespace keys it uses.

The script queries "Wyoming Higher Education" (a real, live framework
whose items all populate this field — verified against the real
server: 1058 of 1058) and prints one full example of each genuinely
different kind of item it finds in a sample page — a county, a
college, and a degree program — so the variety in what `extensions`
actually holds is visible in one run, not just one repeated shape.

What you'll see uses `ext:ctdl`/`ext:digicred` keys — but that's
`catalog-graphql`'s own convention for its own frameworks (see that
service's `caseData.ts`), not something this module assumes. A
different CASE consumer's frameworks could use entirely different
namespace keys, and this module would handle it exactly the same way:
pass it through, unopinionated, as JSON.
