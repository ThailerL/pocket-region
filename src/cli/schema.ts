import { flagCase } from './args.ts';

// Each SDK Command carries its operation's input shape, as nested arrays the client's own
// serializer reads. Their layout is the SDK's own, so every read here is guarded
export type MemberKind =
  | 'string'
  | 'boolean'
  | 'number'
  | 'blob'
  | 'timestamp'
  | 'document'
  | 'list'
  | 'map'
  | 'structure';

// The schema is carried so a value that holds more values, a list of structures among them,
// can be read the same way one member down
export type Member = { name: string; flag: string; kind?: MemberKind; schema: unknown };

// Keyed by the member's letters alone, so --queue-url and --queueurl both reach QueueUrl
export type Members = Map<string, Member>;

type CommandClass = new (input: object) => unknown;

// A simple type is a number, carrying a modifier where it is held in a list or a map
const LIST_MODIFIER = 64;
const MAP_MODIFIER = 128;

const SIMPLE: Record<number, MemberKind> = {
  0: 'string',
  1: 'number',
  2: 'boolean',
  4: 'timestamp',
  5: 'timestamp',
  6: 'timestamp',
  7: 'timestamp',
  15: 'document',
  17: 'number',
  19: 'number',
  21: 'blob',
  42: 'blob',
};

// A shape with a name of its own is an array, and its first entry says which kind. A named
// simple type, SSECustomerKey among them, holds the type it stands for at index 4
const NAMED = 0;
const LIST = 1;
const MAP = 2;
const STRUCTURE = 3;
// A union names its members the way a structure does, and takes the same Key=value
const UNION = 4;
const CONTAINER: Record<number, MemberKind> = {
  [LIST]: 'list',
  [MAP]: 'map',
  [STRUCTURE]: 'structure',
  [UNION]: 'structure',
};

export const flagKey = (flag: string) => flag.replace(/-/g, '').toLowerCase();

const known = new WeakMap<CommandClass, Members | undefined>();

export function membersOf(Command: CommandClass): Members | undefined {
  if (!known.has(Command)) known.set(Command, membersFrom(at(schemaOf(Command), 4)));
  return known.get(Command);
}

// The members of a structure, which an operation's input is one of. An operation that takes
// no input has none, and is not the same answer as an SDK whose shape could not be read:
// undefined is only the second, and only that one falls back to spelling a key from a flag
export function membersFrom(schema: unknown): Members | undefined {
  const shape = unwrap(schema);
  const names = at(shape, 4);
  const schemas = at(shape, 5);
  if (!Array.isArray(names) || !Array.isArray(schemas)) return undefined;
  const members: Members = new Map();
  for (const [index, name] of names.entries()) {
    if (typeof name !== 'string') continue;
    const member = schemas[index];
    members.set(flagKey(name), {
      name,
      flag: flagCase(name),
      kind: kindOf(member),
      schema: member,
    });
  }
  return members;
}

// What a list holds, or what a map holds against its keys
export function elementOf(schema: unknown): unknown {
  const shape = unwrap(schema);
  // A list or a map of a simple type is that type with a modifier set
  if (typeof shape === 'number') return shape & ~(LIST_MODIFIER | MAP_MODIFIER);
  if (!Array.isArray(shape)) return undefined;
  return shape[0] === MAP ? shape[5] : shape[4];
}

// The shape hangs off an instance, so an empty command is built to read it
function schemaOf(Command: CommandClass) {
  try {
    return (new Command({}) as { schema?: unknown }).schema;
  } catch {
    return undefined;
  }
}

const at = (schema: unknown, index: number) => (Array.isArray(schema) ? schema[index] : undefined);

// A shape that would otherwise refer to itself is deferred behind a function
const expand = (schema: unknown) =>
  typeof schema === 'function' ? (schema as () => unknown)() : schema;

// A member is its type beside its traits, which say where on the wire it goes
function unwrap(schema: unknown): unknown {
  const shape = expand(schema);
  return Array.isArray(shape) && shape.length === 2 ? unwrap(shape[0]) : shape;
}

export function kindOf(schema: unknown): MemberKind | undefined {
  const shape = unwrap(schema);
  if (typeof shape === 'number') {
    if (shape & MAP_MODIFIER) return 'map';
    if (shape & LIST_MODIFIER) return 'list';
    return SIMPLE[shape];
  }
  if (!Array.isArray(shape) || typeof shape[0] !== 'number') return undefined;
  return shape[0] === NAMED ? kindOf(shape[4]) : CONTAINER[shape[0]];
}
