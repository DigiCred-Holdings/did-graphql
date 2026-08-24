import { gunzipSync } from 'fflate'

/**
 * Gzip member header magic (`1f 8b`). Used instead of trusting
 * `Content-Encoding`: browsers and Node `fetch` often already inflated
 * the body and may still advertise gzip, while React Native often
 * leaves the compressed bytes in place.
 */
export function isGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/**
 * Pure-JS inflate — the React Native path (`DecompressionStream` is
 * missing on Hermes).
 */
export function inflateGzipWithFflate(bytes: Uint8Array): Uint8Array {
  try {
    return gunzipSync(bytes)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`gzip inflate failed: ${detail}`)
  }
}

async function inflateGzipWithDecompressionStream(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('gzip')
  const writer = stream.writable.getWriter()
  const write = writer.write(bytes as BufferSource).then(() => writer.close())
  const out = new Uint8Array(await new Response(stream.readable).arrayBuffer())
  await write
  return out
}

export async function inflateGzipToUtf8(bytes: Uint8Array): Promise<string> {
  let inflated: Uint8Array
  if (typeof DecompressionStream === 'function') {
    inflated = await inflateGzipWithDecompressionStream(bytes)
  } else {
    inflated = inflateGzipWithFflate(bytes)
  }
  return new TextDecoder().decode(inflated)
}

/**
 * Parse a GraphQL (or any) JSON body, inflating gzip when the bytes
 * still start with the gzip magic. Safe to call after a `fetch` that
 * already decompressed: those bodies start with `{` / `[`, not `1f 8b`.
 */
export async function decodeJsonBody<T = unknown>(bytes: Uint8Array): Promise<T> {
  const text = isGzipMagic(bytes) ? await inflateGzipToUtf8(bytes) : new TextDecoder().decode(bytes)
  return JSON.parse(text) as T
}

/**
 * `res.json()` replacement for this client. Custom transports that
 * send `Accept-Encoding: gzip` MUST use this (or `decodeJsonBody`)
 * instead of `res.json()` — Node `fetch` disables auto-decompress
 * when that header is set, and React Native often never decompresses.
 */
export async function readJsonResponse<T = unknown>(res: Response): Promise<T> {
  return decodeJsonBody<T>(new Uint8Array(await res.arrayBuffer()))
}
