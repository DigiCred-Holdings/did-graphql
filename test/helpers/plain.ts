/**
 * graphql-js's `execute()` returns result objects built with
 * `Object.create(null)` (no prototype) rather than plain object
 * literals. `assert.deepEqual`/`deepStrictEqual` under
 * `node:assert/strict` compare `[[Prototype]]` too, so a
 * `{ ... }` literal expectation never matches — even when every key
 * and value is identical. GraphQL results are JSON-serializable by
 * definition (that's what actually goes over HTTP), so a JSON
 * round-trip is a safe, exact way to strip that prototype difference
 * before comparing.
 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
