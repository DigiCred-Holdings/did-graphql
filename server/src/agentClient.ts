// Calls the tenant's own ACA-Py agent when a DID on the chain is not
// did:key. Local verify (localVerify.ts) handles did:key + eddsa-jcs-2022
// without these routes. See w3c_vc/routes.py for the real implementations
// these wrap (zcaps/verify, zcaps/invoke/verify). Minting a root is not
// on the query path — reconstructFullChain / materializeRoot does that
// in-process.

export interface AgentConfig {
  baseUrl: string
  token: string
  apiKey?: string | null
}

export interface ProblemDetail {
  type?: string
  title?: string
  [key: string]: unknown
}

export interface VerificationResult {
  verified: boolean
  rootController: string | null
  invocationController: string | null
  invocationTarget: string | null
  attenuation: Record<string, unknown> | null
  errors: ProblemDetail[]
  warnings: ProblemDetail[]
}

export interface Capability {
  id: string
  controller: string
  invocationTarget: string
  parentCapability?: string
  allowedAction?: string[]
  expires?: string
  proof?: Record<string, unknown>
  [key: string]: unknown
}

async function agentPost<T>(config: AgentConfig, path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.token}`,
  }
  if (config.apiKey) headers['x-api-key'] = config.apiKey

  const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`agent request to ${path} failed: ${res.status} ${text.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

/**
 * Reconstructs the bare root capability (POST /w3c-vc/zcaps/root) —
 * per spec, roots are unsigned and trusted by local dereference, so
 * this is NOT calling into a stored/transmitted object; it's a pure
 * deterministic derivation from invocationTarget + controller that
 * both sides can independently compute. See mint_root() in
 * w3c_vc/zcap/manager.py.
 */
export function mintRootCapability(
  config: AgentConfig,
  params: { invocationTarget: string; controller: string },
): Promise<Capability> {
  return agentPost(config, '/w3c-vc/zcaps/root', params)
}

export function verifyChain(
  config: AgentConfig,
  params: {
    chain: Capability[]
    trustedRootController?: string
    expectedInvocationTarget?: string
  },
): Promise<VerificationResult> {
  return agentPost(config, '/w3c-vc/zcaps/verify', params)
}

export function verifyInvocation(
  config: AgentConfig,
  params: {
    invocation: Record<string, unknown>
    chain: Capability[]
    trustedRootController?: string
    expectedInvocationTarget?: string
  },
): Promise<VerificationResult> {
  return agentPost(config, '/w3c-vc/zcaps/invoke/verify', params)
}
