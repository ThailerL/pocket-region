import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CodeEntry, LambdaExecutor } from '../core.ts';
import { failure, FunctionPool } from './pool.ts';
import { RUNTIME_SOURCE } from './runtime.generated.ts';

export type LambdaHostOptions = {
  // Handlers dial this from their own process, so the region must be served here
  endpoint: string;
  onOutput?: (line: string) => void;
};

export function createLambdaHost({ endpoint, onOutput }: LambdaHostOptions): LambdaExecutor {
  let root: Promise<string> | undefined;
  const unpacked = new Map<string, Promise<string>>();
  const pools = new Map<string, FunctionPool>();

  const workspace = () =>
    (root ??= mkdtemp(path.join(tmpdir(), 'pocket-region-lambda-')).then(async (directory) => {
      await writeFile(path.join(directory, 'runtime.mjs'), RUNTIME_SOURCE);
      return directory;
    }));

  async function unpack(codeSha256: string, entries: CodeEntry[]) {
    // The hash is base64, which is not a directory name
    const taskRoot = path.join(await workspace(), Buffer.from(codeSha256, 'base64').toString('hex'));
    const files = entries
      .map(([file, contents, mode]) => ({ target: path.join(taskRoot, file), contents, mode }))
      .filter(({ target }) => target.startsWith(taskRoot + path.sep));
    const directories = new Set(files.map(({ target }) => path.dirname(target)));
    await Promise.all([...directories].map((directory) => mkdir(directory, { recursive: true })));
    await Promise.all(
      files.map(({ target, contents, mode }) => writeFile(target, contents, { mode: mode || undefined })),
    );
    return taskRoot;
  }

  return {
    needsCode: (codeSha256) => !unpacked.has(codeSha256),

    async execute(invocation) {
      const { config, code } = invocation;
      const { Runtime, CodeSha256, FunctionName, Version } = config;
      if (!Runtime.startsWith('nodejs')) {
        return failure({
          errorType: 'Runtime.Unsupported',
          errorMessage: `Pocket Region runs nodejs functions only; this one is ${Runtime || 'a container image'}`,
        });
      }
      if (code && !unpacked.has(CodeSha256)) unpacked.set(CodeSha256, unpack(CodeSha256, code));
      const taskRoot = await unpacked.get(CodeSha256);
      if (taskRoot === undefined) {
        return failure({ errorType: 'Runtime.InitError', errorMessage: 'The function has no code' });
      }
      // The hash gives updated code fresh environments while the old ones drain
      const key = `${FunctionName}:${Version}:${CodeSha256}`;
      let pool = pools.get(key);
      if (!pool) {
        // No await between get and set, or two first invocations each make a pool
        const runtimeScript = path.join(path.dirname(taskRoot), 'runtime.mjs');
        pool = new FunctionPool({ runtimeScript, taskRoot, endpoint, onOutput });
        pools.set(key, pool);
      }
      return pool.invoke(invocation);
    },

    async stop() {
      await Promise.all([...pools.values()].map((pool) => pool.stop()));
      pools.clear();
      if (root) await rm(await root, { recursive: true, force: true });
    },
  };
}
