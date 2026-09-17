---
"@digicredholdingsinc/did-graphql-client": minor
"@digicredholdingsinc/did-graphql-server": minor
---

Support RFC 9421 HTTP Message Signatures — the ZCAP spec's own invocation proof.

A request signed this way carries `Content-Digest`, `Signature-Input` and `Signature`, over exactly the components the spec's Example 9 lists: `@method`, `@path`, `capability-invocation`, `content-digest`, `content-type`. That binds the proof to *this* HTTP request rather than to a standalone document.

Clients opt in with a `httpSignature` signer, the same injected shape as `invokeCapability` — this package still holds no keys. Servers pass the request to `checkInvocation`'s new optional fourth argument; a signature cannot be verified without the method, path, headers and body, none of which are reconstructible from the capability header.

The embedded `eddsa-jcs-2022` invocation still works and is still accepted, so existing signers migrate on their own schedule. They are not equivalent: the embedded proof binds the target URL and the query text, while an HTTP signature additionally binds the method, the path, the capability header, and the exact request body. A request carrying `Signature-Input` is verified that way and the embedded path is not consulted, so a weak proof cannot be presented alongside a strong one.

The configured freshness window (`invocationMaxAgeSeconds`) applies to both, reading `created` from `Signature-Input` on the signature path.

The signature base is built independently in each package, since a resource server must not depend on the client. A test asserts the two produce byte-identical output — without it, any drift would surface only as an opaque "signature failed verification".
