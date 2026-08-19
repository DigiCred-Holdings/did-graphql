import { randomUUID } from 'node:crypto'

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

export async function createDidKey(agent: Agent): Promise<DidKeyPair> {
  const key = await agent.kms.createKeyForSignatureAlgorithm({ algorithm: 'EdDSA' })
  const created = await agent.dids.create({
    method: 'key',
    options: { keyId: key.keyId },
  })
  if (created.didState.state !== 'finished' || !created.didState.did) {
    throw new Error(`did:key create failed: ${JSON.stringify(created.didState)}`)
  }
  const did = created.didState.did
  const fingerprint = DidKey.fromDid(did).publicJwk.fingerprint
  return {
    did,
    verificationMethod: `${did}#${fingerprint}`,
    keyId: key.keyId,
  }
}
