import { CreateFunctionCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LambdaEvent } from '../core.ts';
import { createRegion } from '../node.ts';
import { requestHandler } from '../request-handler.ts';
import { serve } from '../server.ts';
import { authorization, clientConfig, zipOf } from '../testing/clients.ts';
import { freePort, runNode } from '../testing/support.ts';

describe('Lambda in Node', () => {
  // The host serves the region itself, but a caller may already have
  it('shares the port with a server the caller started', async () => {
    const shared = await createRegion({ port: await freePort() });
    const server = await serve(shared);
    const lambda = new LambdaClient(clientConfig({ requestHandler: requestHandler(shared) }));
    const code = `export const handler = async () => {
      const response = await fetch(process.env.AWS_ENDPOINT_URL + '/shared', { method: 'PUT', headers: { authorization: ${JSON.stringify(authorization('s3'))} } });
      return { created: response.status };
    };`;
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: 'echo',
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::000000000000:role/lambda',
        Code: { ZipFile: zipOf('index.mjs', code) },
      }),
    );
    const { Payload } = await lambda.send(new InvokeCommand({ FunctionName: 'echo' }));
    expect(JSON.parse(new TextDecoder().decode(Payload))).toEqual({ created: 200 });
    await shared.stop();
    await server.close();
  }, 30_000);

  it("reports the pid of each environment's process", async () => {
    const observed: LambdaEvent[] = [];
    const region = await createRegion({ port: await freePort(), lambda: { onEvent: (event) => observed.push(event) } });
    const lambda = new LambdaClient(clientConfig({ requestHandler: requestHandler(region) }));
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: 'whoami',
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::000000000000:role/lambda',
        Code: { ZipFile: zipOf('index.mjs', 'export const handler = async () => ({ pid: process.pid });') },
      }),
    );
    const { Payload } = await lambda.send(new InvokeCommand({ FunctionName: 'whoami' }));
    const { pid } = JSON.parse(new TextDecoder().decode(Payload));
    const started = observed.find((event) => event.kind === 'environment' && event.phase === 'started');
    const spawned = observed.find((event) => event.kind === 'environment' && event.phase === 'spawned');
    expect(spawned).toEqual({ kind: 'environment', functionName: 'whoami', environment: started?.environment, phase: 'spawned', pid });
    await region.stop();
  }, 30_000);

  // The region's thread copies the environment as it starts
  async function failedWorkspace() {
    const missing = path.join(tmpdir(), `pocket-region-missing-${process.pid}`);
    vi.stubEnv('TMPDIR', missing);
    const region = await createRegion({ port: await freePort() }).finally(() => vi.unstubAllEnvs());
    const lambda = new LambdaClient(clientConfig({ requestHandler: requestHandler(region) }));
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: 'one',
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::000000000000:role/lambda',
        Code: { ZipFile: zipOf('index.mjs', 'export const handler = async () => 1;') },
      }),
    );
    const invoke = async () => new TextDecoder().decode((await lambda.send(new InvokeCommand({ FunctionName: 'one' }))).Payload);
    expect(await invoke()).toContain("Could not unpack the function's code");
    return { region, invoke, missing };
  }

  it('stops after its workspace could not be made', async () => {
    const { region } = await failedWorkspace();
    await region.stop();
  }, 30_000);

  it('makes its workspace on the next pack after it could not be made', async () => {
    const { region, invoke, missing } = await failedWorkspace();
    try {
      await mkdir(missing);
      expect(await invoke()).toBe('1');
      await region.stop();
    } finally {
      await rm(missing, { recursive: true, force: true });
    }
  }, 30_000);

  // In a process of its own, where nothing but the region can keep Node running
  async function runAlone(code: string, expected: string) {
    const module = JSON.stringify(new URL('../node.ts', import.meta.url).href);
    const zip = JSON.stringify(Buffer.from(zipOf('index.mjs', code)).toString('base64'));
    const script = `
      import { createRegion } from ${module};
      const region = await createRegion();
      const call = (method, path, body) => region.dispatch({ method, path, headers: { host: 'localhost:4566', authorization: ${JSON.stringify(authorization('lambda'))}, 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });
      await call('POST', '/2015-03-31/functions', { FunctionName: 'one', Runtime: 'nodejs22.x', Handler: 'index.handler', Role: 'r', Code: { ZipFile: ${zip} } });
      const invoked = new TextDecoder().decode((await call('POST', '/2015-03-31/functions/one/invocations', {})).body);
      if (!invoked.includes(${JSON.stringify(expected)})) throw new Error('unexpected ' + invoked);
      await region.stop();
    `;
    expect(await runNode(script, 30_000)).toEqual({ code: 0, stderr: '' });
  }

  it('lets Node exit once a region that ran a function is stopped', async () => {
    await runAlone('export const handler = async () => 1', '1');
  }, 40_000);

  // An environment that dies without a word, as it does when its runtime cannot be found
  it('keeps Node running until an environment that died starting has been answered for', async () => {
    await runAlone('process.exit(3);', 'stopped before it asked for an invocation');
  }, 40_000);
});
