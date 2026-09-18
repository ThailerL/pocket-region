import { withClientConfig } from './client-classes.ts';
import { clientConfig } from './client-config.ts';
import type { Dispatcher } from './core.ts';

// Never the caller's requestHandler: code written for AWS could pass one and reach AWS
export function withRegion<T extends object>(module: T, region: Dispatcher): T {
  return withClientConfig(module, (config) => {
    const defaults = clientConfig(region);
    return { ...defaults, ...config, requestHandler: defaults.requestHandler };
  });
}
