import { NormalizedSchema } from '@smithy/core/schema';
import { describe, expect, it } from 'vitest';
import { serviceNames } from './dispatch.ts';
import { kindOf, membersOf, type MemberKind } from './schema.ts';

// src/cli/schema.ts decodes the SDK's schema arrays itself, since @smithy/core cannot be
// imported where a host loads its clients from a CDN. This reads the same shapes through
// @smithy/core's own reader, so a format the decoder stops understanding fails here by name
const CLIENTS = [
  's3',
  'sqs',
  'sns',
  'dynamodb',
  'lambda',
  'kinesis',
  'kms',
  'secrets-manager',
  'ssm',
  'eventbridge',
  'cloudwatch-logs',
];

type Readable = Parameters<typeof NormalizedSchema.of>[0];

function reference(schema: unknown): MemberKind | undefined {
  const shape = NormalizedSchema.of(schema as Readable);
  if (shape.isListSchema()) return 'list';
  if (shape.isMapSchema()) return 'map';
  if (shape.isStructSchema()) return 'structure';
  if (shape.isDocumentSchema()) return 'document';
  if (shape.isBlobSchema()) return 'blob';
  if (shape.isTimestampSchema()) return 'timestamp';
  if (shape.isStringSchema()) return 'string';
  if (shape.isBooleanSchema()) return 'boolean';
  if (shape.isNumericSchema() || shape.isBigIntegerSchema() || shape.isBigDecimalSchema()) {
    return 'number';
  }
  return undefined;
}

describe('the schema decoder against the SDK reader that cannot be bundled', () => {
  it('names every service the CLI is tested against', async () => {
    const modules = Object.fromEntries(
      await Promise.all(
        CLIENTS.map(async (name) => [name, await import(`@aws-sdk/client-${name}`)] as const),
      ),
    );
    expect(serviceNames(modules)).toEqual(expect.arrayContaining(CLIENTS));
  });

  it.each(CLIENTS)('agrees on every input member of every %s operation', async (name) => {
    const module = (await import(`@aws-sdk/client-${name}`)) as Record<string, unknown>;
    // $Command is the base class every client exports, which no operation ever names
    const commands = Object.entries(module).filter(
      ([key, value]) => key.endsWith('Command') && !key.startsWith('$') && typeof value === 'function',
    );
    expect(commands.length).toBeGreaterThan(0);

    const disagreed: string[] = [];
    let read = 0;
    for (const [key, Command] of commands) {
      const members = membersOf(Command as new (input: object) => unknown);
      // Undefined is "the shape could not be read at all", which no installed client should be
      expect(members, `${name} ${key} carries no readable input shape`).toBeDefined();
      const input = new (Command as new (input: object) => { schema: unknown[] })({}).schema[4];
      const shape = NormalizedSchema.of((input as () => Readable)());
      for (const [memberName, member] of shape.structIterator()) {
        const ours = membersFor(members!, memberName)?.kind;
        const theirs = reference(member.getSchema());
        read += 1;
        if (ours !== theirs) disagreed.push(`${name} ${key} ${memberName}: ${ours} not ${theirs}`);
      }
    }
    expect(disagreed).toEqual([]);
    expect(read).toBeGreaterThan(0);
  });
});

const membersFor = (members: ReturnType<typeof membersOf>, name: string) =>
  [...(members ?? [])].map(([, member]) => member).find((member) => member.name === name);

it('decodes a type the SDK gives a name of its own, not only a bare one', () => {
  // [kind, namespace, name, traits, the type it stands for], which the decoder must follow
  expect(kindOf([0, 'com.amazonaws.s3', 'SSECustomerKey', 8, 0])).toBe('string');
  expect(kindOf([0, 'com.amazonaws.s3', 'StreamingBlob', { streaming: 1 }, 42])).toBe('blob');
});
