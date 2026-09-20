import type { AwsCredentials, Dispatcher } from './core.ts';
import { requestHandler } from './request-handler.ts';

// What code written for AWS gets from its environment, in any language that reaches a region
export const AWS_DEFAULTS = {
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

// The same, as the environment variables every AWS SDK reads
export const awsEnvironment = (credentials: AwsCredentials): Record<string, string> => ({
  AWS_REGION: AWS_DEFAULTS.region,
  AWS_DEFAULT_REGION: AWS_DEFAULTS.region,
  AWS_ACCESS_KEY_ID: credentials.accessKeyId,
  AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  ...(credentials.sessionToken && { AWS_SESSION_TOKEN: credentials.sessionToken }),
});

// The same read back, as a client whose SDK doesn't read the environment takes it; path style
// because the region's S3 answers on one host
export const clientConfigFrom = (env: Record<string, string | undefined>) => ({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
    sessionToken: env.AWS_SESSION_TOKEN,
  },
  endpoint: env.AWS_ENDPOINT_URL,
  forcePathStyle: true,
});

// What an SDK client of the region needs that against AWS would come from the environment
export const clientConfig = (region: Dispatcher) => ({ ...AWS_DEFAULTS, requestHandler: requestHandler(region) });
