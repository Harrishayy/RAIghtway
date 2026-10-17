// The single place to adapt the console to a backend. Most backends need only the env vars in
// .env.example; for anything else (renamed fields, an envelope, auth headers, a different stage
// vocabulary) edit `http` below, or return your own RaightwayClient from `custom`.
import { createClient, type ClientConfig, type RaightwayClient } from '@raightway/core';
import { env } from './env';

export const clientConfig: ClientConfig = env.dataSource === 'http'
  ? {
      source: 'http',
      http: {
        label: 'API',
        baseUrl: env.apiBaseUrl,
        endpoints: env.endpoints,
        capabilities: env.capabilities,
        timeoutMs: env.timeoutMs,
        depot: env.depot,
        // headers: () => ({ Authorization: `Bearer ${token}` }),
        // transform: { issues: raw => (raw as { items: unknown[] }).items },
        // stage: raw => (raw === 'detect' ? 'find' : null),
      },
    }
  : { source: 'mock', mock: { latencyMs: 140 } };

export const makeClient = (): RaightwayClient => createClient(clientConfig);
