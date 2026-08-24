import type http from 'node:http'
import zlib from 'node:zlib'

/**
 * GZIP the JSON body when the client sends Accept-Encoding: gzip —
 * same helper as catalog-graphql. The wallet did-graphql-client always
 * sends that header; CASE list JSON (repeated keys / statements)
 * compresses well. Plain JSON if the client does not advertise gzip.
 */
export function sendJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const acceptsGzip = (req.headers['accept-encoding'] as string | undefined)?.includes('gzip') ?? false
  if (!acceptsGzip) {
    res.writeHead(statusCode, { 'content-type': 'application/json' })
    res.end(body)
    return
  }
  res.writeHead(statusCode, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
  res.end(zlib.gzipSync(body))
}
