import type { CodeEntry, Dispatcher, LambdaExecutor, LambdaObserver } from '../core.ts';
import { failure, FunctionPool, type SandboxFactory } from './pool.ts';

// What either host takes: the region it runs beside, and where its handlers' output goes
export type RegionHostOptions = {
  port: number;
  dispatch: Dispatcher['dispatch'];
  lambda: LambdaObserver;
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
  lambda: LambdaObserver;
};

export function createLambdaHost<Package>(
  packaging: HostPackaging<Package>,
  { endpoint, lambda }: HostOptions,
): LambdaExecutor {
  const packed = new Map<string, Promise<Package>>();
  const pools = new Map<string, FunctionPool>();

  const stopPools = async (reason: string) => {
    const stopping = [...pools.values()];
    pools.clear();
    await Promise.all(stopping.map((pool) => pool.stop(reason)));
  };

  return {
    needsCode: (codeSha256) => !packed.has(codeSha256),

    async execute(invocation) {
      const { config, code } = invocation;
      const { Runtime, CodeSha256, FunctionName, RevisionId } = config;
      if (!Runtime.startsWith('nodejs')) {
        return failure(`Pocket Region runs nodejs functions only; this one is ${Runtime || 'a container image'}`);
      }
      if (code && !packed.has(CodeSha256)) packed.set(CodeSha256, packaging.pack(CodeSha256, code));
      const pkg = await packed.get(CodeSha256);
      if (pkg === undefined) {
        return failure('The function has no code');
      }
      // Updated code or configuration gets fresh environments while the old ones drain
      const key = `${FunctionName}:${RevisionId}`;
      let pool = pools.get(key);
      if (!pool) {
        // No await between get and set, or two first invocations each make a pool
        pool = new FunctionPool({ spawn: packaging.spawn(pkg), endpoint, lambda });
        pools.set(key, pool);
      }
      return pool.invoke(invocation);
    },

    // Packages are named by their code hash, so they stay valid across a reset
    reset: () => stopPools('the region reset'),

    async stop() {
      await stopPools('the region stopped');
      await packaging.dispose();
    },
  };
}
