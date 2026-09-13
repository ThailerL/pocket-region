import type { CodeEntry, Dispatcher, LambdaExecutor } from '../core.ts';
import { failure, FunctionPool, type SandboxFactory } from './pool.ts';

// What either host takes: the region it runs beside, and where its handlers' output goes
export type RegionHostOptions = {
  port: number;
  dispatch: Dispatcher['dispatch'];
  onOutput?: (line: string) => void;
};

// What a host adds to the pool: where a package goes and how an environment runs it
export type HostPackaging<Package> = {
  pack(codeSha256: string, entries: CodeEntry[]): Promise<Package>;
  spawn(pkg: Package): SandboxFactory;
  dispose(): Promise<void>;
};

export type HostOptions = {
  // What a handler's AWS_ENDPOINT_URL names
  endpoint: string;
  onOutput?: (line: string) => void;
};

export function createLambdaHost<Package>(
  packaging: HostPackaging<Package>,
  { endpoint, onOutput }: HostOptions,
): LambdaExecutor {
  const packed = new Map<string, Promise<Package>>();
  const pools = new Map<string, FunctionPool>();

  return {
    needsCode: (codeSha256) => !packed.has(codeSha256),

    async execute(invocation) {
      const { config, code } = invocation;
      const { Runtime, CodeSha256, FunctionName, Version } = config;
      if (!Runtime.startsWith('nodejs')) {
        return failure({
          errorType: 'Runtime.Unsupported',
          errorMessage: `Pocket Region runs nodejs functions only; this one is ${Runtime || 'a container image'}`,
        });
      }
      if (code && !packed.has(CodeSha256)) packed.set(CodeSha256, packaging.pack(CodeSha256, code));
      const pkg = await packed.get(CodeSha256);
      if (pkg === undefined) {
        return failure({ errorType: 'Runtime.InitError', errorMessage: 'The function has no code' });
      }
      // The hash gives updated code fresh environments while the old ones drain
      const key = `${FunctionName}:${Version}:${CodeSha256}`;
      let pool = pools.get(key);
      if (!pool) {
        // No await between get and set, or two first invocations each make a pool
        pool = new FunctionPool({ spawn: packaging.spawn(pkg), endpoint, onOutput });
        pools.set(key, pool);
      }
      return pool.invoke(invocation);
    },

    async stop() {
      await Promise.all([...pools.values()].map((pool) => pool.stop()));
      pools.clear();
      await packaging.dispose();
    },
  };
}
