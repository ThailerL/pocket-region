// The messages between a page's region proxy and its worker
import type { LambdaEvent, LambdaOutput, RegionConfig, RegionOutput, RegionRequest, RegionResponse, StateFiles } from '../core.ts';

// line is where in a snippet the error came from, when a runner's worker could tell
export type WireError = { name: string; message: string; stack?: string; line?: number };

export type RegionCall = { method: 'dispatch'; request: RegionRequest } | { method: 'reset' | 'save' | 'stop' };
export type StoreCall = { method: 'load' } | { method: 'replace'; files: StateFiles } | { method: 'close' };

// pythonRuntime is the wheel URLs a Python function's environment preinstalls
export type BootAssets = { indexURL: string; pyodideVersion: string; stdLib: string; wheels: string[]; pythonRuntime: string[] };

// Only what the page listens to is posted
export type Listening = { output: boolean; lambdaOutput: boolean; lambdaEvents: boolean };

export type ToRegionWorker =
  | { type: 'boot'; assets: BootAssets; config: RegionConfig; hasStore: boolean; listening: Listening }
  | ({ type: 'call'; id: number } & RegionCall)
  | { type: 'stored'; id: number; files?: StateFiles; error?: WireError }
  | { type: 'resolved'; id: number; urls?: Record<string, string>; error?: WireError }
  // Another worker's way in, served like this one and answered with booted
  | { type: 'connect'; port: MessagePort };

export type FromRegionWorker =
  | { type: 'booted'; port: number }
  | { type: 'boot-failed'; error: WireError }
  | { type: 'done'; id: number; response?: RegionResponse }
  | { type: 'failed'; id: number; error: WireError }
  | { type: 'output'; output: RegionOutput }
  | { type: 'lambda-output'; output: LambdaOutput }
  | { type: 'lambda-event'; event: LambdaEvent }
  | ({ type: 'store'; id: number } & StoreCall)
  // A worker has no import map, so the page resolves a handler's bare imports
  | { type: 'resolve'; id: number; specifiers: string[] };

export type Endpoint<Out, In> = {
  postMessage(message: Out, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<In>) => void) | null;
};

// DedicatedWorkerGlobalScope, without the lib that names it
export const workerEndpoint = <Out, In>() => self as unknown as Endpoint<Out, In>;

type Settled<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

// A call whose method answers nothing resolves undefined, which its caller discards
export function pendingCalls<T>() {
  const pending = new Map<number, Settled<T>>();
  let next = 0;
  return {
    start: (send: (id: number) => void) =>
      new Promise<T>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        send(id);
      }),
    settle(id: number, value?: T, error?: WireError) {
      const settled = pending.get(id);
      pending.delete(id);
      if (error) settled?.reject(fromWire(error));
      else settled?.resolve(value as T);
    },
    fail(error: Error) {
      for (const { reject } of pending.values()) reject(error);
      pending.clear();
    },
  };
}

// One request from the far side, answered with its value or its error
export async function answer<T>(produce: () => Promise<T>, reply: (value?: T, error?: WireError) => void) {
  try {
    reply(await produce());
  } catch (error) {
    reply(undefined, toWire(error));
  }
}

export function toWire(error: unknown): WireError {
  const { name, message, stack, line } = (error ?? {}) as Partial<Error & { line: unknown }>;
  return { name: name ?? 'Error', message: message ?? String(error), stack, line: typeof line === 'number' ? line : undefined };
}

export function fromWire({ name, message, stack, line }: WireError): Error {
  const error = new Error(message);
  // Error.name lives on the prototype; an SDK's NoSuchBucket keeps its name this way
  Object.defineProperty(error, 'name', { value: name, configurable: true, writable: true });
  if (stack) error.stack = stack;
  if (line !== undefined) Object.assign(error, { line });
  return error;
}
