// A snippet worker's side of the runner's protocol: the port to the region arrives after the code, under the run's id
import type { Region } from '../core.ts';
import { fromWire, toWire, workerEndpoint, type WireError } from '../region/protocol.ts';
import { regionOver } from '../region/proxy.ts';
import type { FromRunnerWorker, ToRunnerWorker } from './protocol.ts';

export type RunMessage = ToRunnerWorker & { type: 'run' };
type Other = ToRunnerWorker & { type: 'boot' | 'resolved' };
type Waiting = { resolve: (port: MessagePort) => void; reject: (error: Error) => void };

const port = workerEndpoint<FromRunnerWorker, ToRunnerWorker>();
export const post = (message: FromRunnerWorker) => port.postMessage(message);

// A run either throws or hands back a failure already in wire form
export function serveRuns(run: (data: RunMessage, region: Promise<Region>) => Promise<WireError | undefined | void>, other: (data: Other) => void = () => {}) {
  const regions = new Map<number, Waiting>();
  port.onmessage = async ({ data }) => {
    switch (data.type) {
      case 'region': {
        const waiting = regions.get(data.id)!;
        regions.delete(data.id);
        return data.port ? waiting.resolve(data.port) : waiting.reject(fromWire(data.error!));
      }
      case 'run': {
        const regionPort = new Promise<MessagePort>((resolve, reject) => regions.set(data.id, { resolve, reject }));
        try {
          const failure = await run(data, regionPort.then((connected) => regionOver(connected, {})));
          post(failure ? { type: 'failed', id: data.id, error: failure } : { type: 'done', id: data.id });
        } catch (error) {
          post({ type: 'failed', id: data.id, error: toWire(error) });
        } finally {
          // Also a run that failed before its port arrived
          regionPort.then((connected) => connected.close(), () => {});
        }
        return;
      }
      default:
        other(data);
    }
  };
}
