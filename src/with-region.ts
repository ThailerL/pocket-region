import { clientConfig } from './client-config.ts';
import type { Dispatcher } from './core.ts';

type ClientClass = new (config?: object) => object;

// Never the caller's requestHandler: code written for AWS could pass one and reach AWS
export function withRegion<T extends object>(module: T, region: Dispatcher): T {
  // Every SDK client package exports its clients' base class; any other module passes through
  const Base = (module as { __Client?: ClientClass }).__Client;
  if (typeof Base !== 'function') return module;

  const entries = Object.entries(module).map(([name, value]) => {
    if (typeof value !== 'function' || !(value.prototype instanceof Base)) return [name, value];
    const Client = value as ClientClass;
    const Defaulted = class extends Client {
      constructor(config: object = {}) {
        const defaults = clientConfig(region);
        super({ ...defaults, ...config, requestHandler: defaults.requestHandler });
      }
    };
    Object.defineProperty(Defaulted, 'name', { value: name });
    return [name, Defaulted];
  });
  return Object.fromEntries(entries) as T;
}
