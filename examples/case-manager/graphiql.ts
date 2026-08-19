// A real, interactive GraphiQL page for GET /graphql — adapted from
// catalog-graphql's own graphiql.ts (the reference consumer of this
// package), trimmed down since this example is always unsafeMode (no
// real-vs-unsafe branch needed here). Loaded from a CDN (React +
// GraphiQL UMD builds) — fine for a local example server, not meant
// for a CSP-constrained production surface.

export function renderGraphiQLPage(options: { headerValue: string; defaultQuery: string }): string {
  const defaultHeaders = JSON.stringify({ 'x-zcap-invocation': options.headerValue }, null, 2)

  return `<!doctype html>
<html>
<head>
  <title>case-manager</title>
  <meta charset="utf-8" />
  <link rel="icon" href="data:," />
  <style>html, body, #graphiql { height: 100%; margin: 0; }</style>
  <link rel="stylesheet" href="https://unpkg.com/graphiql@3/graphiql.min.css" />
</head>
<body>
  <div id="graphiql">Loading GraphiQL...</div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/graphiql@3/graphiql.min.js"></script>
  <script>
    const fetcher = GraphiQL.createFetcher({ url: '/graphql' })
    const root = ReactDOM.createRoot(document.getElementById('graphiql'))
    root.render(
      React.createElement(GraphiQL, {
        fetcher,
        defaultHeaders: ${JSON.stringify(defaultHeaders)},
        defaultQuery: ${JSON.stringify(options.defaultQuery)},
      })
    )
  </script>
</body>
</html>
`
}
