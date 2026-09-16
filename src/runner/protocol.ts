// The messages between createRunner on the page and the worker a snippet runs in
import type { WireError } from '../region/protocol.ts';

export type RunnerStream = 'log' | 'error';

export type ToRunnerWorker =
  // A port to the region follows once it has booted
  | { type: 'run'; id: number; code: string }
  | { type: 'region'; port?: MessagePort; error?: WireError }
  | { type: 'resolved'; id: number; url?: string; error?: WireError };

export type FromRunnerWorker =
  | { type: 'resolve'; id: number; specifier: string }
  | { type: 'output'; stream: RunnerStream; text: string }
  | { type: 'done'; id: number }
  | { type: 'failed'; id: number; error: WireError };
