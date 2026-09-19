import { clientConfig } from '../client-config.ts';
import type { Dispatcher } from '../core.ts';
import { promiseCache } from '../promise-cache.ts';
import { flagCase, type Invocation } from './args.ts';
import { UsageError } from './errors.ts';
import type { Files } from './files.ts';
import { paramsFor } from './params.ts';
import { membersOf } from './schema.ts';

export type SdkModule = Record<string, unknown>;
export type SdkClient = { send(command: unknown): Promise<Record<string, unknown>> };

// Keyed by the resolved SDK name, so one entry serves a service and its aliases
export type Modules = Record<string, SdkModule>;

// A service's module and its client. Both are needed per command: the operation's Command
// class comes off the module, and only the module can name the client class
export type Services = {
  module(service: string): Promise<SdkModule>;
  client(service: string): Promise<SdkClient>;
};

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

// The CLI's name for a service is the SDK's, apart from a handful AWS spells differently
export const resolve = (service: string) => PACKAGES[service] ?? service;

export const packageFor = (service: string) => `@aws-sdk/client-${resolve(service)}`;

// The CLI names for the modules a caller supplied, aliases included, which is the whole list
// of services that host can reach
export function serviceNames(modules: Modules) {
  const given = Object.keys(modules);
  const aliases = Object.keys(PACKAGES).filter((alias) => given.includes(PACKAGES[alias]!));
  return [...given, ...aliases].sort();
}

export async function moduleFor(service: string, modules?: Modules): Promise<SdkModule> {
  if (!SERVICE_PATTERN.test(service)) throw new UsageError(`"${service}" is not a service name`);
  if (modules) {
    // Supplied modules are the whole world: importing is not an option a host that bundles
    // has, and its loader's failure is not one this can read
    const given = modules[resolve(service)];
    if (given) return given;
    // The usage text under this names what the build does have
    throw new UsageError(`unknown service "${service}"`);
  }
  const name = packageFor(service);
  if (resolvable(name) === false) throw unreachable(service, name);
  try {
    return (await import(/* @vite-ignore */ name)) as SdkModule;
  } catch (error) {
    // A client that is installed and broken must keep its own error: install advice would
    // bury it. Only a failure to resolve the name means the service is not here
    if (!unresolvable(error)) throw error;
    throw unreachable(service, name);
  }
}

const unreachable = (service: string, name: string) =>
  new UsageError(`unknown service "${service}", or its client is neither installed nor given:
  npm install ${name}
  or awsCli(region, { modules: { ${resolve(service)}: await import('${name}') } })`);

// Asks the loader whether the name resolves at all, which separates a missing client from a
// broken one. Undefined where the host has no import.meta.resolve, and the error decides
function resolvable(name: string) {
  const resolver = import.meta.resolve as ((specifier: string) => string) | undefined;
  if (typeof resolver !== 'function') return undefined;
  try {
    resolver(name);
    return true;
  } catch {
    return false;
  }
}

// Only for a loader with no import.meta.resolve, which browsers and Node both have: a host
// that resolves modules itself, as Vivari's VM does, says this much and names no code
export function unresolvable(error: unknown) {
  const failure = error as { code?: string; message?: string };
  return (
    failure?.code === 'ERR_MODULE_NOT_FOUND' ||
    /cannot find (module|package)/i.test(failure?.message ?? '')
  );
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
export function servicesFor(
  region: Dispatcher,
  options: { modules?: Modules; client?: object } = {},
): Services {
  const built = promiseCache<SdkClient>();
  const imported = promiseCache<SdkModule>();
  // Every command asks twice - once for the operation's Command class, once for the client -
  // and the resolve and the import behind that are worth doing only the first time
  const module = (service: string) => imported(resolve(service), () => moduleFor(service, options.modules));
  return {
    module,
    client(service) {
      const name = resolve(service);
      return built(name, async () => {
        const Client = clientClass(await module(service), service);
        return new Client({
          ...clientConfig(region),
          endpoint: 'http://localhost:4566',
          ...options.client,
          // Last, so a caller can move the endpoint and the credentials without being able to
          // lose the addressing a service needs
          ...OPTIONS[name],
        });
      });
    },
  };
}

export async function commandFor(service: string, operation: string, services: Services) {
  const module = await services.module(service);
  const Command = module[`${operation}Command`];
  if (typeof Command !== 'function') {
    throw new UsageError(`unknown operation "${flagCase(operation)}" for "${service}"`, service);
  }
  return Command as new (params: object) => unknown;
}

export async function dispatch(invocation: Invocation, services: Services, files?: Files) {
  const { service, operation } = invocation;
  const Command = await commandFor(service, operation, services);
  const params = await paramsFor(invocation, membersOf(Command), files);
  const client = await services.client(service);
  const { $metadata, ...rest } = await client.send(new Command(params));

  let stdout = '';
  // A streamed payload is what the caller asked for, so it goes to stdout as itself
  const stream = Object.keys(rest).find(
    (key) => typeof (rest[key] as { transformToString?: unknown })?.transformToString === 'function',
  );
  if (stream) {
    stdout += await (rest[stream] as { transformToString(): Promise<string> }).transformToString();
    // The body is whatever was stored, newline or not, so the metadata below needs its own line
    if (stdout && !stdout.endsWith('\n')) stdout += '\n';
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
