type ClientClass = new (config?: object) => object;

// Each client class of an SDK client package, subclassed to pass its config through configure;
// any other module passes through
export function withClientConfig<T extends object>(module: T, configure: (config: object) => object): T {
  // Every SDK client package exports its clients' base class
  const Base = (module as { __Client?: ClientClass }).__Client;
  if (typeof Base !== 'function') return module;

  const entries = Object.entries(module).map(([name, value]) => {
    if (typeof value !== 'function' || !(value.prototype instanceof Base)) return [name, value];
    const Client = value as ClientClass;
    const Configured = class extends Client {
      constructor(config: object = {}) {
        super(configure(config));
      }
    };
    Object.defineProperty(Configured, 'name', { value: name });
    return [name, Configured];
  });
  return Object.fromEntries(entries) as T;
}
