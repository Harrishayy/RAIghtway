import { createHttpClient, type HttpClientConfig } from './http';
import { createMockClient, type MockClientOptions } from '../mock/client';
import type { RaightwayClient } from './types';

export * from './types';
export { createHttpClient, DEFAULT_ENDPOINTS, defaultStage, type Endpoints, type HttpClientConfig } from './http';
export { createMockClient, type MockClientOptions } from '../mock/client';

export type ClientConfig =
  | { source: 'mock'; mock?: MockClientOptions }
  | { source: 'http'; http?: HttpClientConfig }
  | { source: 'custom'; create: () => RaightwayClient };

/** One switch for the whole app: sample data, the REST API, or any adapter you write. */
export function createClient(config: ClientConfig): RaightwayClient {
  if (config.source === 'http') return createHttpClient(config.http);
  if (config.source === 'custom') return config.create();
  return createMockClient(config.mock);
}
