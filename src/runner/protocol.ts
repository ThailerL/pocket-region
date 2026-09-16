// The messages between createRunner on the page and the worker a snippet runs in
import type { RegionOutput } from '../core.ts';
import type { WireError } from '../region/protocol.ts';

export type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error' | 'table' | 'dir';
// values are the console call's arguments, each copied to the page or, when it can't be, its text
export type RunnerOutput = RegionOutput & { method: ConsoleMethod; values: unknown[] };

export type ToRunnerWorker =
  // A port to the region follows under the same id, once the run may start
  | { type: 'run'; id: number; code: string }
  | { type: 'region'; id: number; port?: MessagePort; error?: WireError }
  | { type: 'resolved'; id: number; url?: string; error?: WireError };

export type FromRunnerWorker =
  | { type: 'resolve'; id: number; specifier: string }
  | { type: 'output'; output: RunnerOutput }
  | { type: 'done'; id: number }
  | { type: 'failed'; id: number; error: WireError };
