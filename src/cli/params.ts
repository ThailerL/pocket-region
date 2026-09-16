import { flagCase, parseValue, pascalCase, type Invocation } from './args.ts';
import { UsageError } from './errors.ts';
import { elementOf, flagKey, type Member, type Members } from './schema.ts';
import { fromShorthand, scalar, type Where } from './shorthand.ts';

// Flags the real CLI reads for itself, which a region has no use for: it has one endpoint,
// one set of credentials, and no pager
const NO_OP_HERE = new Set(
  [
    'region',
    'profile',
    'endpoint-url',
    'color',
    'debug',
    'no-verify-ssl',
    'no-paginate',
    'no-cli-pager',
    'cli-auto-prompt',
    'no-cli-auto-prompt',
    'cli-connect-timeout',
    'cli-read-timeout',
  ].map(flagKey),
);

// Flags the real CLI honours and this cannot, so taking them would answer a different
// question than the one asked
const REFUSED: Record<string, string> = {
  output: 'output is always JSON here',
  query: 'a query is not applied here',
  'cli-binary-format': 'a blob is read as the text it was given here',
};

const CLI_INPUT_JSON = flagKey('cli-input-json');

// The few flags the real CLI spells differently from the API member behind them, keyed
// service.operation.flag. The real CLI keeps the same kind of table, for the same reason:
// nothing in the API's own shape says the flag was renamed
const RENAMES: Record<string, string> = { 'sns.subscribe.notification-endpoint': 'Endpoint' };

const RENAMED_FROM = new Map(
  Object.entries(RENAMES).map(([where, name]) => [flagKey(where), { name, flag: cliFlag(where) }]),
);

// The other direction, so the member's own name is refused where the CLI renamed it
const RENAMED_TO = new Map(
  Object.entries(RENAMES).map(([where, name]) => [
    flagKey(`${where.split('.').slice(0, 2).join('.')}.${name}`),
    cliFlag(where),
  ]),
);

function cliFlag(where: string) {
  return where.split('.').slice(2).join('.');
}

export function paramsFor({ service, operation, flags }: Invocation, members?: Members) {
  const params: Record<string, unknown> = {};
  const document: Record<string, unknown> = {};

  for (const { flag, values } of flags) {
    const key = flagKey(flag);
    if (key === CLI_INPUT_JSON) {
      Object.assign(document, inputDocument(values, service));
      continue;
    }
    if (!members) {
      const name = pascalCase(flag);
      params[name] = values.length === 0 ? true : parseValue(name, values[0] as string);
      continue;
    }
    // The real CLI gives every boolean a --no- form, and that is how documentation turns one off
    const negated = key.startsWith('no') ? members.get(key.slice(2)) : undefined;
    if (negated?.kind === 'boolean') {
      params[negated.name] = false;
      continue;
    }
    const member = memberFor(key, service, operation, members);
    // Checked after the members, so a real input member of the same name always wins
    if (!member && NO_OP_HERE.has(key)) continue;
    if (!member && REFUSED[key]) throw new UsageError(`--${flag}: ${REFUSED[key]}`, service);
    if (!member) throw unknownFlag(flag, service, operation, members);
    params[member.name] = valueOf(member, values, service);
  }

  // Explicit flags win over the document, whichever side of it they are typed
  return { ...document, ...params };
}

// The member a flag names, under the name the real CLI gives it: where the two differ, the
// member carries the CLI's spelling, so every failure below names the flag that was typed
function memberFor(key: string, service: string, operation: string, members: Members) {
  const where = flagKey(`${service}.${operation}.${key}`);
  const renamed = RENAMED_FROM.get(where);
  if (renamed) {
    const member = members.get(flagKey(renamed.name));
    return member && { ...member, flag: renamed.flag };
  }
  const member = members.get(key);
  // The API's own name for a renamed member is not a flag the real CLI takes
  if (member && RENAMED_TO.has(flagKey(`${service}.${operation}.${member.name}`))) return undefined;
  return member;
}

function valueOf(member: Member, values: string[], service: string): unknown {
  const where: Where = { flag: member.flag, service };
  if (values.length === 0) {
    if (member.kind === 'boolean' || member.kind === undefined) return true;
    throw new UsageError(`--${member.flag} takes a value`, service);
  }
  // A list is the one member that takes the values the real CLI lets follow a flag
  if (member.kind === 'list') {
    if (values.length === 1) return structured(values[0] as string, member.schema, where);
    const element = elementOf(member.schema);
    return values.map((value) => structured(value, element, where));
  }
  if (values.length > 1) {
    throw new UsageError(`--${member.flag} takes one value, not ${values.length}`, service);
  }
  const value = values[0] as string;
  switch (member.kind) {
    case 'map':
    case 'structure':
    case 'document':
      return structured(value, member.schema, where);
    case undefined:
      return parseValue(member.name, value);
    default:
      // A string is kept as typed, which is what a JSON message body or an S3 object needs
      return scalar(value, member.kind, where);
  }
}

// JSON first, since a value written as JSON is meant as JSON, and the shorthand's own
// brackets get their turn only when it does not parse
function structured(value: string, schema: unknown, where: Where): unknown {
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      // Shorthand starts the same way in [a,b] and {A=1}
    }
  }
  return fromShorthand(value, schema, where);
}

function inputDocument(values: string[], service: string) {
  const value = values[0];
  if (value === undefined) throw new UsageError('--cli-input-json takes a JSON document', service);
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch (error) {
    throw new UsageError(`--cli-input-json is not valid JSON: ${(error as Error).message}`, service);
  }
}

function unknownFlag(flag: string, service: string, operation: string, members: Members) {
  const key = flagKey(flag);
  const renamed = RENAMED_TO.get(flagKey(`${service}.${operation}.${flag}`));
  const near = renamed
    ? [`--${renamed}`]
    : [...members]
        .filter(([other]) => other.includes(key) || key.includes(other))
        .slice(0, 3)
        .map(([, member]) => `--${member.flag}`);
  const advice = near.length > 0 ? `, did you mean ${near.join(' or ')}?` : '';
  return new UsageError(
    `unknown option "--${flag}" for "${service} ${flagCase(operation)}"${advice}`,
    service,
  );
}
