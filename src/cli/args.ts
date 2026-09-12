import { UsageError } from './errors.ts';

export type Invocation = { service: string; operation: string; params: Record<string, unknown> };

export function pascalCase(name: string) {
  return name.replace(/(^|-)([a-z0-9])/g, (_, __, character: string) => character.toUpperCase());
}

export const kebabCase = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// String-typed in the SDK, and often JSON themselves, so they must not be parsed
const STRING_FLAGS = new Set(['MessageBody', 'Body', 'Payload']);

export function parseValue(key: string, raw: string): unknown {
  if (STRING_FLAGS.has(key)) return raw;
  if (!/^[[{]|^-?\d|^true$|^false$|^null$/.test(raw)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// A command typed as one line, split the way a shell would: quotes hold a value together
export function tokenize(command: string) {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const [, doubled, singled, bare] of command.matchAll(pattern)) {
    tokens.push(doubled?.replace(/\\(.)/g, '$1') ?? singled ?? bare ?? '');
  }
  return tokens;
}

export function parseArgs(argv: string[]): Invocation {
  const [service, operation, ...rest] = argv;
  if (!service) throw new UsageError('no service given');
  // Whether the service exists is dispatch.ts's answer: it is whatever client is installed
  if (!operation) throw new UsageError(`no operation given for "${service}"`, service);

  let params: Record<string, unknown> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] as string;
    if (!flag.startsWith('--')) throw new UsageError(`unexpected argument "${flag}"`, service);
    // --key=value, as the real CLI takes and documentation often shows
    const equals = flag.indexOf('=');
    const attached = equals === -1 ? undefined : flag.slice(equals + 1);
    const key = pascalCase((equals === -1 ? flag : flag.slice(0, equals)).slice(2));
    const next = attached ?? rest[index + 1];
    // A flag with no value is a boolean, as it is in the real CLI
    if (next === undefined || (attached === undefined && next.startsWith('--'))) {
      params[key] = true;
      continue;
    }
    if (key === 'CliInputJson') {
      // Explicit flags win over the document, whichever side of it they are typed
      try {
        params = { ...JSON.parse(next), ...params };
      } catch (error) {
        throw new UsageError(
          `--cli-input-json is not valid JSON: ${(error as Error).message}`,
          service,
        );
      }
    } else {
      params[key] = parseValue(key, next);
    }
    if (attached === undefined) index += 1;
  }

  return { service, operation: pascalCase(operation), params };
}
