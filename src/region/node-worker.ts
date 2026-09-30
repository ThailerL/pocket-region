// A Node region, started by createRegion in a worker thread, answering on the port it was handed
import { workerData } from 'node:worker_threads';
import { nodeHost } from './node-host.ts';
import { serveRegion } from './serve.ts';

serveRegion(workerData.port, nodeHost);
