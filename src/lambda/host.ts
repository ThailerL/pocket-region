import type { CodeEntry, LambdaExecutor, LambdaObserver } from '../core.ts';
import { failure, FunctionPool, hostError, type RuntimeFamily, type SandboxFactory } from './pool.ts';

// What a host adds to the pool: where a package goes and how an environment runs it
export type HostPackaging<Package> = {
  pack(codeSha256: string, entries: CodeEntry[]): Promise<Package>;
  spawn(pkg: Package, family: RuntimeFamily): SandboxFactory;
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
      // MiniStack sends only these two here, and refuses provided.* in python/lambda.py
      const family: RuntimeFamily = Runtime.startsWith('python') ? 'python' : 'nodejs';
      if (code && !packed.has(CodeSha256)) packed.set(CodeSha256, packaging.pack(CodeSha256, code));
      const pkg = await packed.get(CodeSha256);
      if (pkg === undefined) {
        return failure(hostError('The function has no code'));
      }
      // Updated code or configuration gets fresh environments while the old ones drain
      const key = `${FunctionName}:${RevisionId}`;
      let pool = pools.get(key);
      if (!pool) {
        // No await between get and set, or two first invocations each make a pool
        pool = new FunctionPool({ spawn: packaging.spawn(pkg, family), endpoint, lambda });
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
