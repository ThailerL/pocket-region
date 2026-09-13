// The messages between worker-host.ts and worker-runtime.ts. Types only: the runtime ships
// as a string and may import no value
import type { LambdaError } from './pool.ts';

export type FetchRequest = {
  type: 'fetch';
  id: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
};

export type FetchReply = {
  type: 'fetched';
  id: number;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

export type ToWorker =
  | { type: 'init'; env: Record<string, string>; source: Uint8Array; exportName: string }
  | { type: 'invocation'; requestId: string; deadline: number; arn: string; event: string }
  | FetchReply;

export type FromWorker =
  | { type: 'next' }
  | { type: 'response'; requestId: string; result: string }
  | { type: 'error'; requestId: string; error: LambdaError }
  | { type: 'init-error'; error: LambdaError }
  | { type: 'output'; line: string }
  | FetchRequest;
