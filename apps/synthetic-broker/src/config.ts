import path from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const EnvSchema = z
  .object({
    OMNIS_BROKER_SOCKET: z.string().startsWith('/'),
    OMNIS_BROKER_CALLER_TOKEN_FILE: z.string().startsWith('/'),
    OMNIS_BROKER_AUTHORIZER_SOCKET: z.string().startsWith('/'),
    OMNIS_BROKER_AUTHORIZER_TOKEN_FILE: z.string().startsWith('/'),
    OMNIS_BROKER_TRUST_ANCHORS: z.string().min(1),
    OMNIS_FAKE_PROVIDER_TOKEN_FILE: z.string().startsWith('/'),
  })
  .strict();

export type BrokerConfig = {
  socketPath: string;
  callerToken: string;
  authorizerSocketPath: string;
  authorizerToken: string;
  trustAnchors: string;
  providerToken: string;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const values = EnvSchema.parse({
    OMNIS_BROKER_SOCKET: env.OMNIS_BROKER_SOCKET,
    OMNIS_BROKER_CALLER_TOKEN_FILE: env.OMNIS_BROKER_CALLER_TOKEN_FILE,
    OMNIS_BROKER_AUTHORIZER_SOCKET: env.OMNIS_BROKER_AUTHORIZER_SOCKET,
    OMNIS_BROKER_AUTHORIZER_TOKEN_FILE: env.OMNIS_BROKER_AUTHORIZER_TOKEN_FILE,
    OMNIS_BROKER_TRUST_ANCHORS: env.OMNIS_BROKER_TRUST_ANCHORS,
    OMNIS_FAKE_PROVIDER_TOKEN_FILE: env.OMNIS_FAKE_PROVIDER_TOKEN_FILE,
  });
  if (values.OMNIS_BROKER_SOCKET === values.OMNIS_BROKER_AUTHORIZER_SOCKET) {
    throw new Error('Broker and authorizer socket paths must be distinct.');
  }
  const callerToken = readToken(values.OMNIS_BROKER_CALLER_TOKEN_FILE);
  const authorizerToken = readToken(values.OMNIS_BROKER_AUTHORIZER_TOKEN_FILE);
  const providerToken = readToken(values.OMNIS_FAKE_PROVIDER_TOKEN_FILE);
  if (!/^[a-f0-9]{64,128}$/i.test(callerToken)) throw new Error('Broker caller token is invalid.');
  if (!/^[a-f0-9]{64,128}$/i.test(authorizerToken))
    throw new Error('Broker authorizer token is invalid.');
  if (providerToken.length < 32) throw new Error('Synthetic provider token is invalid.');
  if (callerToken === authorizerToken) throw new Error('Broker IPC tokens must be distinct.');
  return {
    socketPath: path.normalize(values.OMNIS_BROKER_SOCKET),
    callerToken,
    authorizerSocketPath: path.normalize(values.OMNIS_BROKER_AUTHORIZER_SOCKET),
    authorizerToken,
    trustAnchors: values.OMNIS_BROKER_TRUST_ANCHORS,
    providerToken,
  };
}

function readToken(filePath: string): string {
  return readFileSync(filePath, 'utf8').trim();
}
