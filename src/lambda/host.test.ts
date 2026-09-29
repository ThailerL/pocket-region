import { describe, expect, it } from 'vitest';
import type { FunctionConfig, Invocation } from '../core.ts';
import { createLambdaHost } from './host.ts';

const CODE_SHA = 'c2hh';

const invocation: Invocation = {
  requestId: 'request',
  config: { FunctionName: 'f', Runtime: 'nodejs22.x', CodeSha256: CODE_SHA, RevisionId: 'r1' } as FunctionConfig,
  event: '{}',
  code: [['index.mjs', new Uint8Array(), 0o644]],
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

const offlineHost = () =>
  createLambdaHost(
    {
      pack: () => Promise.reject(new Error('offline')),
      spawn: () => expect.unreachable(),
      dispose: async () => {},
    },
    { endpoint: 'http://localhost:4566', lambda: {} },
  );

describe('createLambdaHost', () => {
  it('answers a failed pack as the invocation error', async () => {
    const outcome = await offlineHost().execute(invocation);
    expect(outcome).toMatchObject({ error: { errorMessage: expect.stringContaining('offline') } });
  });

  it('asks for the code again after packing it failed', async () => {
    const host = offlineHost();
    await host.execute(invocation);
    expect(host.needsCode(CODE_SHA)).toBe(true);
  });
});
