---
"@digicred-holdings/did-graphql-client": patch
---

Cache leaf ZCAP JSON when encoding invoked headers, send Accept-Encoding: gzip, and inflate responses from gzip magic bytes (DecompressionStream or fflate) so React Native and Node fetch both work.
