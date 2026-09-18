// The messages between worker-host.ts and worker-runtime.ts. Types only: the runtime ships
// as a string and may import no value
import type { LambdaError } from '../core.ts';
import type { PythonRuntime } from './pool.ts';

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

export type NodeInit = {
  family: 'nodejs';
  // The package's modules by path, their imports rewritten into calls of the global named importer
  files: Map<string, Uint8Array>;
  importer: string;
  handler: string;
  exportName: string;
  // The URLs those imports name, to load while the handler does
  preload: string[];
  // What an SDK client made with no options gets
  defaults: object;
  // The DOM parser the SDK's browser build reads XML with, which a worker lacks
  xmldom: string;
};

// Every file in the package by path, as written
export type PythonInit = { family: 'python'; files: Map<string, Uint8Array> } & PythonRuntime;

export type Init = { type: 'init'; env: Record<string, string>; runtime: NodeInit | PythonInit };

export type ToWorker =
  | Init
  | { type: 'invocation'; requestId: string; deadline: number; arn: string; event: string }
  | FetchReply;

export type FromWorker =
  | { type: 'next' }
  | { type: 'response'; requestId: string; result: string }
  | { type: 'error'; requestId: string; error: LambdaError }
  | { type: 'init-error'; error: LambdaError }
  | { type: 'output'; line: string }
  | FetchRequest;
