// What both entries export
export type {
  Dispatch,
  Dispatcher,
  LambdaEnvironment,
  LambdaEvent,
  LambdaObserver,
  LambdaOutput,
  OutputStream,
  Region,
  RegionOutput,
  RegionRequest,
  RegionResponse,
  RegionSettings,
  StateFiles,
  StateStore,
} from './core.ts';
// Whether createRegion can boot here, named for the capability rather than the Wasm feature behind it
export { jspiSupported as regionSupported } from './core.ts';
export * from './cli/index.ts';
export { clientConfig } from './client-config.ts';
export * from './request-handler.ts';
