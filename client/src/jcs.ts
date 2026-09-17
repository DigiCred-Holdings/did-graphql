// JSON Canonicalization Scheme (RFC 8785).
//
// Vendored rather than depended on. Three reasons, in order of weight:
//
// 1. This produces the exact bytes that get hashed and signed, so its
//    output is part of the wire format. A dependency changing it — even
//    accidentally — silently breaks signature compatibility with every
//    other implementation, including CrMS's Python signer. Owning it
//    means that can only happen if we change this file, which the
//    fixture tests then catch.
// 2. The algorithm is frozen. RFC 8785 is not going to gain features,
//    so there is no upstream improvement to miss by not depending on a
//    package.
// 3. Packaging. The `canonicalize` package went ESM-only at 3.x with an
//    `exports` map offering no `require` condition, plus
//    `engines: node >=22`. That is unreachable from any CJS consumer —
//    including Jest, which is how a React Native app tests — while
//    contributing nothing to output. Forty lines is not worth inheriting
//    another project's packaging decisions.
//
// `canonicalize` is kept as a dev dependency and this file is
// differentially tested against it, so equivalence with the reference
// implementation is proven on every CI run without shipping it.

/**
 * Serialize `value` per RFC 8785.
 *
 * Object keys are sorted, `undefined` and symbol-valued properties are
 * dropped (matching `JSON.stringify`), `toJSON` is honoured, and NaN /
 * Infinity are rejected rather than silently becoming `null` — they are
 * not representable in JSON, and signing something that does not
 * round-trip would be worse than failing.
 */
export function canonicalize(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new Error('NaN is not allowed')
    if (!Number.isFinite(value)) throw new Error('Infinity is not allowed')
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  // Unwrap before inspecting the shape: a Date, or anything else with a
  // toJSON, canonicalizes as whatever it serializes to.
  const withToJson = value as { toJSON?: unknown }
  if (typeof withToJson.toJSON === 'function') {
    return canonicalize((withToJson.toJSON as () => unknown)())
  }

  if (Array.isArray(value)) {
    // Array.from, not map: map SKIPS holes rather than passing undefined,
    // so `[, , 1].map(...)` leaves holes in the result and join() emits
    // empty fields — producing `[,,1]`, which is not even valid JSON, and
    // `[,]` collapsing to `[]` with the wrong length. Array.from
    // materialises holes as undefined so they become null here, which is
    // what JSON.stringify does.
    const items = Array.from(value, (entry) =>
      entry === undefined || typeof entry === 'symbol' ? 'null' : canonicalize(entry),
    )
    return `[${items.join(',')}]`
  }

  const source = value as Record<string, unknown>
  // Sorted by UTF-16 code unit, which is what the default sort does and
  // what RFC 8785 requires.
  const entries = Object.keys(source)
    .sort()
    .filter((key) => source[key] !== undefined && typeof source[key] !== 'symbol')
    .map((key) => `${JSON.stringify(key)}:${canonicalize(source[key])}`)
  return `{${entries.join(',')}}`
}

export default canonicalize
