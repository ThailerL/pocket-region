import { UsageError } from './errors.ts';

// A flag takes every value up to the next flag, since that is how the real CLI takes a list.
// No values at all is the boolean form
export type Flag = { flag: string; values: string[] };

export type Invocation = { service: string; operation: string; flags: Flag[] };

export function pascalCase(name: string) {
  return name.replace(/(^|-)([a-z0-9])/g, (_, __, character: string) => character.toUpperCase());
}

// botocore's rule, which is where the real CLI's flag names come from: SSESpecification is
// --sse-specification, and SSEKMSKeyId is --ssekms-key-id
export const flagCase = (name: string) =>
  name
    .replace(/[A-Z]{2,}s$/, (acronym) => `-${acronym}`)
    .replace(/(.)([A-Z][a-z]+)/g, '$1-$2')
    .replace(/([a-z])(\d+)/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();

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

  const flags: Flag[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] as string;
    if (!argument.startsWith('--'))
      throw new UsageError(`unexpected argument "${argument}"`, service);
    // --key=value, as the real CLI takes and documentation often shows
    const equals = argument.indexOf('=');
    const flag = (equals === -1 ? argument : argument.slice(0, equals)).slice(2);
    if (equals !== -1) {
      flags.push({ flag, values: [argument.slice(equals + 1)] });
      continue;
    }
    const values: string[] = [];
    while (index + 1 < rest.length && !(rest[index + 1] as string).startsWith('--')) {
      values.push(rest[index + 1] as string);
      index += 1;
    }
    flags.push({ flag, values });
  }

  return { service, operation: pascalCase(operation), flags };
}
