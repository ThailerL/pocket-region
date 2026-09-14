import type * as Lambda from '@aws-sdk/client-lambda';
import type * as Browser from 'pocket-region/browser';

export type LambdaSdk = typeof Lambda;
export type LambdaApi = { sdk: LambdaSdk; client: Lambda.LambdaClient };
export type Aws = ReturnType<typeof Browser.awsCli>;

// A variable specifier, so Vite leaves it to the page's import map: the region, Pyodide, and the
// SDK clients are served as they are, never bundled
const load = <T>(specifier: string): Promise<T> => import(/* @vite-ignore */ specifier);

export const loadModules = () =>
  Promise.all([
    load<typeof Browser>('pocket-region/browser'),
    load<LambdaSdk>('@aws-sdk/client-lambda'),
  ]);
