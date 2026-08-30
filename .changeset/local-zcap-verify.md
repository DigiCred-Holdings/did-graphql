---
"@digicred-holdings/did-graphql-server": minor
---

Verify did:key + eddsa-jcs-2022 ZCAP-LD capabilities entirely in-process — no ACA-Py agent call, no database access from inside this package. `ZcapServerConfig`'s real (non-`unsafeMode`) shape now takes an explicit `rootCapability` (resolved by the caller's own lookup) instead of an `agentConfig`; `agentClient.ts` and `tenants.ts` (`TenantResolver`) are removed. Only `did:key` root controllers are supported — other DID methods now fail closed with `UNSUPPORTED_CONTROLLER` rather than falling through to an agent call. Rejection reasons are now typed `ProblemDetail`s (`urn:zcap:problemDetail:...`) in addition to the existing string `reason`/`message` fields.
