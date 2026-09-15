import type { Dispatcher } from './core.ts';
import { requestHandler } from './request-handler.ts';

// What an SDK client of the region needs that against AWS would come from the environment
export const clientDefaults = (region: Dispatcher) => ({
  region: 'us-east-1',
  credentials: { accessKeyId: 'pocket-region', secretAccessKey: 'pocket-region' },
  requestHandler: requestHandler(region),
});
