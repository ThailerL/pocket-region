import type * as Lambda from '@aws-sdk/client-lambda';
import type * as Browser from 'pocket-region/browser';
import { load } from '../load.ts';

export type LambdaSdk = typeof Lambda;
export type LambdaApi = { sdk: LambdaSdk; client: Lambda.LambdaClient };
export type Aws = ReturnType<typeof Browser.awsCli>;


export const loadModules = () =>
  Promise.all([
    load<typeof Browser>('pocket-region/browser'),
    load<LambdaSdk>('@aws-sdk/client-lambda'),
  ]);
