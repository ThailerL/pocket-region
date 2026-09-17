import type { Dispatcher } from './core.ts';
import { requestHandler } from './request-handler.ts';

// What code written for AWS gets from its environment, in any language that reaches a region
export const AWS_DEFAULTS = {
  region: 'us-east-1',
  credentials: { accessKeyId: 'pocket-region', secretAccessKey: 'pocket-region' },
};

type AwsDefaults = typeof AWS_DEFAULTS;

// The same, as the environment variables every AWS SDK reads
export const awsEnvironment = ({ region, credentials }: AwsDefaults) => ({
  AWS_REGION: region,
  AWS_DEFAULT_REGION: region,
  AWS_ACCESS_KEY_ID: credentials.accessKeyId,
  AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
});

// What an SDK client of the region needs that against AWS would come from the environment
export const clientDefaults = (region: Dispatcher) => ({ ...AWS_DEFAULTS, requestHandler: requestHandler(region) });
