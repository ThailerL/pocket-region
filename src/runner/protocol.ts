// The messages between createRunner on the page and the worker a snippet runs in
import type { RegionOutput } from '../core.ts';
import type { WireError } from '../region/protocol.ts';

export type Language = 'javascript' | 'python';
export type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error' | 'table' | 'dir';
// line is the 1-based line of the snippet whose call made the output, when one was on the stack
type Output = RegionOutput & { line?: number };
// values are the console call's arguments, each copied to the page or, when it can't be, its text
export type JavaScriptOutput = Output & { language: 'javascript'; method: ConsoleMethod; values: unknown[] };
// A Python value is a proxy the page can't be handed, so what was printed is all there is
export type PythonOutput = Output & { language: 'python' };
export type RunnerOutput = JavaScriptOutput | PythonOutput;

// Where a Python snippet's interpreter and packages come from, and what its environment holds
export type PythonBoot = { indexURL: string; packageBaseUrl: string; packages: string[]; environment: Record<string, string> };

export type ToRunnerWorker =
  // Once, to the Python worker, before its first run
  | { type: 'boot'; python: PythonBoot }
  // A port to the region follows under the same id, once the run may start. fresh says the
  // region was just booted or emptied, so the run starts with no state left by earlier ones.
  // echo asks for a session's value printing
  | { type: 'run'; id: number; code: string; fresh: boolean; echo?: boolean }
  | { type: 'region'; id: number; port?: MessagePort; error?: WireError }
  | { type: 'resolved'; id: number; url?: string; error?: WireError };

export type FromRunnerWorker =
  | { type: 'resolve'; id: number; specifier: string }
  | { type: 'output'; output: RunnerOutput }
  | { type: 'done'; id: number }
  | { type: 'failed'; id: number; error: WireError };
