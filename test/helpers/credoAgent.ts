import { createHash, randomUUID } from 'node:crypto'

import { askarNodeJS } from './askarSetup.js'
import { AskarModule } from '@credo-ts/askar'
import {
  Agent,
  ConsoleLogger,
  DidKey,
  DidsModule,
  KeyDidRegistrar,
  KeyDidResolver,
  LogLevel,
} from '@credo-ts/core'
import { agentDependencies } from '@credo-ts/node'
import { Key, KeyAlgorithm } from '@openwallet-foundation/askar-shared'

export interface DidKeyPair {
  did: string
  verificationMethod: string
  keyId: string
}

export async function createTestAgent(): Promise<Agent> {
  const id = `did-graphql-${randomUUID()}`
  const agent = new Agent({
    config: {
      label: id,
      logger: new ConsoleLogger(LogLevel.off),
    },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar: askarNodeJS,
        store: {
          id,
          key: 'insecure-did-graphql-test-key-32b',
          database: { type: 'sqlite', config: { inMemory: true } },
        },
      }),
      dids: new DidsModule({
        registrars: [new KeyDidRegistrar()],
        resolvers: [new KeyDidResolver()],
      }),
    },
  })
  await agent.initialize()
  return agent
}

async function didKeyFromImportedKeyId(agent: Agent, keyId: string): Promise<DidKeyPair> {
  const created = await agent.dids.create({
    method: 'key',
    options: { keyId },
  })
  if (created.didState.state !== 'finished' || !created.didState.did) {
    throw new Error(`did:key create failed: ${JSON.stringify(created.didState)}`)
  }
  const did = created.didState.did
  const fingerprint = DidKey.fromDid(did).publicJwk.fingerprint
  return {
    did,
    verificationMethod: `${did}#${fingerprint}`,
    keyId,
  }
}

export async function createDidKey(agent: Agent): Promise<DidKeyPair> {
  const key = await agent.kms.createKeyForSignatureAlgorithm({ algorithm: 'EdDSA' })
  return didKeyFromImportedKeyId(agent, key.keyId)
}

/**
 * Same result as createDidKey, but deterministic: the same `seed`
 * string always produces the same did:key — useful for a controller
 * identity that should stay stable across restarts (e.g. a sample
 * app's CONTROLLER_SEED env var) without persisting a wallet.
 *
 * Askar's Key.fromSeed needs exactly 32 bytes; an arbitrary seed
 * string is hashed down to that length with sha256 rather than
 * requiring the caller to already have 32 raw bytes on hand.
 */
export async function createDidKeyFromSeed(agent: Agent, seed: string): Promise<DidKeyPair> {
  const seedBytes = createHash('sha256').update(seed, 'utf8').digest()
  const askarKey = Key.fromSeed({ algorithm: KeyAlgorithm.Ed25519, seed: new Uint8Array(seedBytes) })
  const jwk = askarKey.jwkSecret // { kty: 'OKP', crv: 'Ed25519', x, d } — same shape Credo's KMS import expects

  const imported = await agent.kms.importKey({
    privateJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d! },
  })
  return didKeyFromImportedKeyId(agent, imported.keyId)
}
