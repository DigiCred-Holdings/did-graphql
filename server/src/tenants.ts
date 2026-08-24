// Resolves a ZcapServerConfig for a given hostname from digicred-crms's
// own `tenants` table — so a resource server built on this package can
// serve every tenant from one deployment, instead of one fixed
// AGENT_BASE_URL/TRUSTED_ROOT_CONTROLLER per deployment.
//
// This ties the package to digicred-crms's specific Postgres schema
// (the `tenants` table's exact columns) — that's a deliberate scope
// choice, not an oversight: every real consumer of this package today
// is a digicred-crms-tenant-aware service, so the alternative (a
// schema-agnostic tenant-resolution abstraction nobody asked for yet)
// would be speculative generality.
//
// Mirrors two real crms-ui code paths exactly, so a token/DID
// resolved here behaves identically to one resolved by crms-ui itself:
//   - hostname lookup order: exact hostname -> host-without-port ->
//     localhost/127.0.0.1 swap (TenantsService.findByHostname,
//     services/crms-ui/src/tenants/tenants.service.ts:162-185)
//   - Traction Bearer token acquisition (TractionService.fetchToken, …)
//     — only when public_did is not did:key. did:key tenants verify locally
//     and never fetch a token.
//   - tractionTenantApiKey decryption (EncryptionService,
//     services/crms-ui/src/encryption/encryption.service.ts):
//     AES-256-GCM, key = sha256(ENCRYPTION_KEY), format
//     enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>.

import { createDecipheriv, createHash } from 'node:crypto'
import { Pool } from 'pg'
import type { ZcapServerConfig } from './zcap.js'

export interface TenantsDbConfig {
  /** Postgres connection string — the same DB crms-ui itself uses. */
  connectionString: string
  /** Same value as crms-ui's ENCRYPTION_KEY — required to decrypt tractionTenantApiKey. */
  encryptionKey: string
}

interface TenantRow {
  traction_url: string | null
  traction_tenant_id: string | null
  traction_tenant_api_key: string | null
  public_did: string | null
}

const ENC_PREFIX = 'enc:v1:'

/** Exact port of EncryptionService.decrypt — same algorithm, same format, so a value encrypted by crms-ui decrypts identically here. */
function decryptSecret(value: string, encryptionKey: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value
  const parts = value.slice(ENC_PREFIX.length).split(':')
  if (parts.length !== 3 || parts.some((p) => !p)) return value

  const [ivHex, tagHex, ciphertextHex] = parts as [string, string, string]
  try {
    const key = createHash('sha256').update(encryptionKey).digest()
    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(tagHex, 'hex')
    const ciphertext = Buffer.from(ciphertextHex, 'hex')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return value
  }
}

/** Exact port of TractionService.fetchToken's two-shape probe. */
async function fetchTractionToken(
  tractionUrl: string,
  tractionTenantId: string,
  tractionTenantApiKey: string,
): Promise<string> {
  const url = `${tractionUrl.replace(/\/$/, '')}/multitenancy/tenant/${tractionTenantId}/token`
  for (const keyField of ['api_key', 'wallet_key'] as const) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [keyField]: tractionTenantApiKey }),
    })
    if (res.ok) {
      const data = (await res.json()) as { token: string }
      return data.token
    }
    if (keyField === 'api_key' && res.status === 401) continue
    throw new Error(`Traction token request failed: ${res.status}`)
  }
  throw new Error('Traction token request failed: all key formats rejected')
}

const TENANT_QUERY = `
  SELECT traction_url, traction_tenant_id, traction_tenant_api_key, public_did
  FROM tenants
  WHERE hostname = $1
  LIMIT 1
`

export class TenantResolver {
  private pool: Pool
  private encryptionKey: string

  constructor(config: TenantsDbConfig) {
    this.pool = new Pool({ connectionString: config.connectionString })
    this.encryptionKey = config.encryptionKey
  }

  private async findRowByHostname(hostname: string): Promise<TenantRow | null> {
    const candidates = [hostname]
    const hostOnly = hostname.includes(':') ? hostname.slice(0, hostname.indexOf(':')) : null
    if (hostOnly) candidates.push(hostOnly)
    if (hostname === 'localhost') candidates.push('127.0.0.1')
    if (hostname === '127.0.0.1') candidates.push('localhost')

    for (const candidate of candidates) {
      const result = await this.pool.query<TenantRow>(TENANT_QUERY, [candidate])
      if (result.rows[0]) return result.rows[0]
    }
    return null
  }

  /**
   * Resolves a ready-to-use ZcapServerConfig for the tenant matching
   * `hostname`. `did:key` public DIDs verify locally — no Traction
   * token is fetched. Other DID methods still POST for a Bearer token
   * so `checkInvocation` can fall through to the tenant agent.
   */
  async resolveZcapConfig(
    hostname: string,
    opts: { expectedInvocationTarget?: string } = {},
  ): Promise<ZcapServerConfig | null> {
    const row = await this.findRowByHostname(hostname)
    if (!row?.public_did) return null

    const trust = {
      trustedRootController: row.public_did,
      expectedInvocationTarget: opts.expectedInvocationTarget,
    }

    if (row.public_did.startsWith('did:key:')) {
      return { trust }
    }

    if (!row.traction_url || !row.traction_tenant_id || !row.traction_tenant_api_key) {
      return null
    }

    const apiKey = decryptSecret(row.traction_tenant_api_key, this.encryptionKey)
    const token = await fetchTractionToken(row.traction_url, row.traction_tenant_id, apiKey)

    return {
      agentConfig: { baseUrl: row.traction_url, token },
      trust,
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
