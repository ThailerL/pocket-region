import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CreateFunctionCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { describe, expect, it } from 'vitest';
import { createRegion } from '../node.ts';
import { requestHandler } from '../request-handler.ts';
import { serve } from '../server.ts';
import { authorization, clientConfig, zipOf } from '../testing/clients.ts';
import { freePort } from '../testing/support.ts';

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
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal: AbortSignal.timeout(30_000),
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const [exitCode] = await once(child, 'exit');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  }

  it('lets Node exit once a region that ran a function is stopped', async () => {
    await runAlone('export const handler = async () => 1', '1');
  }, 40_000);

  // An environment that dies without a word, as it does when its runtime cannot be found
  it('keeps Node running until an environment that died starting has been answered for', async () => {
    await runAlone('process.exit(3);', 'stopped before it asked for an invocation');
  }, 40_000);
});
