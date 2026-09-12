import type { Dispatcher } from '../core.ts';
import { requestHandler } from '../request-handler.ts';
import { kebabCase, type Invocation } from './args.ts';
import { UsageError } from './errors.ts';

type SdkModule = Record<string, unknown>;
export type SdkClient = { send(command: unknown): Promise<Record<string, unknown>> };
// One client per service, built on first use and kept for the life of the `aws` it belongs to
export type Clients = (service: string) => Promise<SdkClient>;

// SDK v3 input shapes are the CLI's --cli-input-json shapes, so a service needs no code here:
// the client is @aws-sdk/client-<service>, imported only when a command names it, which keeps
// them optional peer dependencies rather than dependencies
const PACKAGES: Record<string, string> = {
  s3api: 's3',
  logs: 'cloudwatch-logs',
  events: 'eventbridge',
  stepfunctions: 'sfn',
  dynamodbstreams: 'dynamodb-streams',
};

// Keyed by the resolved name, so an alias needs no entry of its own. The bucket belongs in
// the URL path, where the region expects it
const OPTIONS: Record<string, object> = {
  s3: { forcePathStyle: true },
};

const SERVICE_PATTERN = /^[a-z][a-z0-9-]*$/;

const CREDENTIALS = { accessKeyId: 'pocket-region', secretAccessKey: 'pocket-region' };

// The CLI's name for a service is the SDK's, apart from a handful AWS spells differently
export const resolve = (service: string) => PACKAGES[service] ?? service;

export const packageFor = (service: string) => `@aws-sdk/client-${resolve(service)}`;

export async function moduleFor(service: string): Promise<SdkModule> {
  if (!SERVICE_PATTERN.test(service)) throw new UsageError(`"${service}" is not a service name`);
  const name = packageFor(service);
  try {
    return (await import(/* @vite-ignore */ name)) as SdkModule;
  } catch (error) {
    // Anything else is a client that is installed and broken, which install advice would bury
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new UsageError(`unknown service "${service}", or its client is not installed:
  npm install ${name}`);
  }
}

// Every client package exports exactly one, named for the service with casing we would only
// get wrong: SQSClient, DynamoDBClient, CloudWatchLogsClient
function clientClass(module: SdkModule, service: string) {
  const name = Object.keys(module).find(
    (key) => key.endsWith('Client') && !key.startsWith('__') && typeof module[key] === 'function',
  );
  if (!name) throw new UsageError(`${packageFor(service)} exports no client`, service);
  return module[name] as new (config: object) => SdkClient;
}

// Rebuilding a client per command costs about a quarter of a command's time, so an `aws`
// keeps the ones it has built
export function clientsFor(region: Dispatcher): Clients {
  const built = new Map<string, Promise<SdkClient>>();
  return (service) => {
    const name = resolve(service);
    const existing = built.get(name);
    if (existing) return existing;
    const building = (async () => {
      const Client = clientClass(await moduleFor(service), service);
      return new Client({
        region: 'us-east-1',
        endpoint: 'http://localhost:4566',
        credentials: CREDENTIALS,
        requestHandler: requestHandler(region),
        ...OPTIONS[name],
      });
    })();
    built.set(name, building);
    // A failure is not the answer for the rest of the session
    building.catch(() => built.delete(name));
    return building;
  };
}

export async function commandFor(service: string, operation: string) {
  const module = await moduleFor(service);
  const Command = module[`${operation}Command`];
  if (typeof Command !== 'function') {
    throw new UsageError(`unknown operation "${kebabCase(operation)}" for "${service}"`, service);
  }
  return Command as new (params: object) => unknown;
}

export async function dispatch({ service, operation, params }: Invocation, clients: Clients) {
  const Command = await commandFor(service, operation);
  const client = await clients(service);
  const { $metadata, ...rest } = await client.send(new Command(params));

  let stdout = '';
  // A streamed payload is what the caller asked for, so it goes to stdout as itself
  const stream = Object.keys(rest).find(
    (key) => typeof (rest[key] as { transformToString?: unknown })?.transformToString === 'function',
  );
  if (stream) {
    stdout += await (rest[stream] as { transformToString(): Promise<string> }).transformToString();
    delete rest[stream];
  }
  if (Object.keys(rest).length > 0) stdout += `${JSON.stringify(decoded(rest), null, 2)}\n`;
  return stdout;
}

// A byte field is text the other side wrote - an Invoke's Payload - shown as it was written
export function decoded(output: Record<string, unknown>) {
  for (const [key, value] of Object.entries(output)) {
    if (!(value instanceof Uint8Array)) continue;
    const text = new TextDecoder().decode(value);
    try {
      output[key] = JSON.parse(text);
    } catch {
      output[key] = text;
    }
  }
  return output;
}
