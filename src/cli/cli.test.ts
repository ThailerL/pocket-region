import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RegionRequest } from '../core.ts';
import { createRegion, type Region } from '../node.ts';
import { flagCase, parseArgs, parseValue, pascalCase, tokenize } from './args.ts';
import { decoded, unresolvable } from './dispatch.ts';
import { UsageError } from './errors.ts';
import { paramsFor } from './params.ts';
import { membersOf } from './schema.ts';
import { awsCli, CliError, type AwsCli } from './index.ts';
import { formatBuckets, formatObjects, parseS3Uri } from './s3-verbs.ts';

describe('pascalCase', () => {
  it('spells an SDK input key from a CLI flag', () => {
    expect(pascalCase('queue-url')).toBe('QueueUrl');
    expect(pascalCase('max-number-of-messages')).toBe('MaxNumberOfMessages');
  });

  it('leaves an already-capitalised segment alone', () => {
    expect(pascalCase('cli-input-json')).toBe('CliInputJson');
  });
});

describe('flagCase', () => {
  it('names an SDK operation back the way it was typed', () => {
    expect(flagCase('SendMessage')).toBe('send-message');
    expect(flagCase('ListObjectsV2')).toBe('list-objects-v2');
  });

  it('breaks an acronym where the real CLI breaks it', () => {
    expect(flagCase('SSESpecification')).toBe('sse-specification');
    expect(flagCase('SSEKMSKeyId')).toBe('ssekms-key-id');
  });
});

describe('parseValue', () => {
  it('keeps a bare word a string', () => {
    expect(parseValue('Bucket', 'notes')).toBe('notes');
    expect(parseValue('Bucket', '3things')).toBe('3things');
  });

  it('parses a structured value', () => {
    expect(parseValue('Item', '{"id": {"S": "1"}}')).toEqual({ id: { S: '1' } });
    expect(parseValue('MaxKeys', '5')).toBe(5);
  });

  it('keeps a JSON message body a string', () => {
    expect(parseValue('MessageBody', '{"userId": 1}')).toBe('{"userId": 1}');
  });
});

describe('tokenize', () => {
  it('splits a typed line the way a shell would', () => {
    expect(tokenize('sqs send-message --queue-url http://q --message-body hi')).toEqual([
      'sqs',
      'send-message',
      '--queue-url',
      'http://q',
      '--message-body',
      'hi',
    ]);
  });

  it('keeps a quoted value together', () => {
    expect(tokenize(`s3api put-object --body '{"a": 1}' --key "two words"`)).toEqual([
      's3api',
      'put-object',
      '--body',
      '{"a": 1}',
      '--key',
      'two words',
    ]);
  });
});

describe('parseArgs', () => {
  it('reads the flags as they were typed', () => {
    expect(parseArgs(['sqs', 'create-queue', '--queue-name', 'orders'])).toEqual({
      service: 'sqs',
      operation: 'CreateQueue',
      flags: [{ flag: 'queue-name', values: ['orders'] }],
    });
  });

  it('takes --key=value, which is how documentation writes it', () => {
    expect(parseArgs(['s3api', 'put-object', '--bucket=notes', '--body={"a": 1}']).flags).toEqual([
      { flag: 'bucket', values: ['notes'] },
      { flag: 'body', values: ['{"a": 1}'] },
    ]);
  });

  it('gives a flag every value up to the next flag, which is how a list is typed', () => {
    const argv = tokenize('sqs get-queue-attributes --attribute-names All Policy --queue-url http://q');
    expect(parseArgs(argv).flags).toEqual([
      { flag: 'attribute-names', values: ['All', 'Policy'] },
      { flag: 'queue-url', values: ['http://q'] },
    ]);
  });

  it('keeps an attached empty value a string, not a boolean', () => {
    expect(parseArgs(['s3api', 'list-objects-v2', '--prefix=']).flags).toEqual([
      { flag: 'prefix', values: [''] },
    ]);
    expect(parseArgs(['s3api', 'list-objects-v2', '--prefix']).flags).toEqual([
      { flag: 'prefix', values: [] },
    ]);
  });

  it('refuses an argument that is not a flag', () => {
    expect(() => parseArgs(['sqs', 'create-queue', 'orders'])).toThrow(UsageError);
  });
});

describe('paramsFor', () => {
  const params = async (command: string, module: Promise<Record<string, unknown>>) => {
    const invocation = parseArgs(tokenize(command));
    const Command = (await module)[`${invocation.operation}Command`] as new (
      input: object,
    ) => unknown;
    return paramsFor(invocation, membersOf(Command));
  };
  const sqs = import('@aws-sdk/client-sqs');
  const sns = import('@aws-sdk/client-sns');
  const s3 = import('@aws-sdk/client-s3');
  const dynamodb = import('@aws-sdk/client-dynamodb');

  it('names the input key the operation itself gives the flag', async () => {
    expect(await params('sqs create-queue --queue-name orders', sqs)).toEqual({
      QueueName: 'orders',
    });
  });

  it('takes the flag the real CLI renamed, which the API spells otherwise', async () => {
    const subscribe = await params(
      'sns subscribe --topic-arn arn:t --protocol sqs --notification-endpoint arn:q',
      sns,
    );
    expect(subscribe).toEqual({ TopicArn: 'arn:t', Protocol: 'sqs', Endpoint: 'arn:q' });
  });

  it('keeps a string member as typed, JSON or not', async () => {
    expect(await params(`sqs send-message --queue-url http://q --message-body '{"a": 1}'`, sqs)) //
      .toEqual({ QueueUrl: 'http://q', MessageBody: '{"a": 1}' });
  });

  it('reads the type the member has, so a number is a number and a map is JSON', async () => {
    expect(
      await params(`s3api list-objects-v2 --bucket notes --max-keys 5 --prefix 3things`, s3),
    ).toEqual({ Bucket: 'notes', MaxKeys: 5, Prefix: '3things' });
    expect(
      await params(`s3api put-object --bucket notes --key a --metadata '{"x": "y"}'`, s3),
    ).toEqual({ Bucket: 'notes', Key: 'a', Metadata: { x: 'y' } });
  });

  it('reads the shorthand the real CLI documents into a list of structures', async () => {
    const created = await params(
      'dynamodb create-table --table-name notes' +
        ' --attribute-definitions AttributeName=id,AttributeType=S' +
        ' --key-schema AttributeName=id,KeyType=HASH',
      dynamodb,
    );
    expect(created).toEqual({
      TableName: 'notes',
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    });
  });

  it('takes a structure written out in full, and one nested inside another', async () => {
    const created = await params(
      'dynamodb create-table --table-name notes' +
        ' --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=2' +
        ' --global-secondary-indexes IndexName=by-tag,Projection={ProjectionType=ALL}',
      dynamodb,
    );
    expect(created).toEqual({
      TableName: 'notes',
      // A number member is a number, which is what the shape says and JSON would need quoting to avoid
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 2 },
      GlobalSecondaryIndexes: [{ IndexName: 'by-tag', Projection: { ProjectionType: 'ALL' } }],
    });
  });

  it('keeps taking the same list as JSON, which is how our own documentation writes it', async () => {
    const created = await params(
      `dynamodb create-table --table-name notes --key-schema '[{"AttributeName":"id","KeyType":"HASH"}]'`,
      dynamodb,
    );
    expect(created.KeySchema).toEqual([{ AttributeName: 'id', KeyType: 'HASH' }]);
  });

  it('takes each value after the flag as an element, and a bare one as a list of one', async () => {
    expect(
      await params('sqs get-queue-attributes --queue-url http://q --attribute-names All Policy', sqs),
    ).toEqual({ QueueUrl: 'http://q', AttributeNames: ['All', 'Policy'] });
    expect(
      await params('sqs get-queue-attributes --queue-url http://q --attribute-names All', sqs),
    ).toEqual({ QueueUrl: 'http://q', AttributeNames: ['All'] });
  });

  it('names the key the structure does not have, and what it has instead', async () => {
    await expect(
      params('dynamodb create-table --key-schema AttributeNam=id,KeyType=HASH', dynamodb),
    ).rejects.toThrow(/has no "AttributeNam".*AttributeName/s);
  });

  it('refuses shorthand that assigns nothing to a key', async () => {
    await expect(
      params('dynamodb create-table --provisioned-throughput ReadCapacityUnits', dynamodb),
    ).rejects.toThrow(/--provisioned-throughput/);
  });

  it('refuses a flag the operation does not take, and names the nearest', async () => {
    await expect(params('sqs create-queue --queue-names orders', sqs)).rejects.toThrow(
      /unknown option "--queue-names".*--queue-name/s,
    );
  });

  it('turns a boolean off through the --no- form the real CLI documents', async () => {
    expect(await params('dynamodb query --table-name notes --no-scan-index-forward', dynamodb)) //
      .toEqual({ TableName: 'notes', ScanIndexForward: false });
  });

  it('accepts and drops the flags the real CLI reads for itself', async () => {
    expect(await params('sqs list-queues --region us-west-2 --no-cli-pager', sqs)).toEqual({});
  });

  it('refuses a flag it would have to ignore to accept, rather than answering something else', async () => {
    await expect(params('sqs list-queues --output text', sqs)).rejects.toThrow(
      /--output: output is always JSON here/,
    );
  });

  it('takes the renamed flag only under the name the real CLI gives it', async () => {
    await expect(params('sns subscribe --endpoint arn:q', sns)).rejects.toThrow(
      /unknown option "--endpoint".*--notification-endpoint/s,
    );
  });

  it('types a member the SDK names in its own right, such as an encryption key', async () => {
    expect(await params('s3api get-object --bucket notes --key a --sse-customer-key 12345', s3)) //
      .toEqual({ Bucket: 'notes', Key: 'a', SSECustomerKey: '12345' });
  });

  it('refuses a flag on an operation that takes no input at all', async () => {
    await expect(params('dynamodb describe-limits --not-a-flag x', dynamodb)).rejects.toThrow(
      /unknown option "--not-a-flag"/,
    );
  });

  it('takes a whole input document, which explicit flags still beat', async () => {
    const command = `dynamodb put-item --cli-input-json '{"TableName": "a", "Item": {}}' --table-name b`;
    expect(await params(command, dynamodb)).toEqual({ TableName: 'b', Item: {} });
  });

  it('spells the key from the flag where an SDK carries no shape to read', () => {
    const invocation = parseArgs(tokenize('sqs create-queue --queue-name orders'));
    expect(paramsFor(invocation, undefined)).toEqual({ QueueName: 'orders' });
  });
});

describe('decoded', () => {
  it('shows a byte payload as the JSON or text it holds', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(decoded({ StatusCode: 200, Payload: bytes('{"got":1}') })).toEqual({
      StatusCode: 200,
      Payload: { got: 1 },
    });
    expect(decoded({ Payload: bytes('plain') })).toEqual({ Payload: 'plain' });
  });
});

describe('parseS3Uri', () => {
  it('splits a bucket from a key', () => {
    expect(parseS3Uri('s3://notes/a/b.txt')).toEqual({ Bucket: 'notes', Key: 'a/b.txt' });
    expect(parseS3Uri('s3://notes')).toEqual({ Bucket: 'notes', Key: '' });
    expect(parseS3Uri('s3://notes/')).toEqual({ Bucket: 'notes', Key: '' });
  });

  it('rejects anything that is not an s3 URI', () => {
    expect(parseS3Uri('./local.txt')).toBeUndefined();
    expect(parseS3Uri(undefined)).toBeUndefined();
  });
});

describe('s3 formatting', () => {
  it('lists buckets by creation date', () => {
    expect(formatBuckets([{ Name: 'notes', CreationDate: '2026-09-08T00:01:02.000Z' }])).toEqual([
      '2026-09-08 00:01:02 notes',
    ]);
  });

  it('lists prefixes before objects, the way the real CLI does', () => {
    expect(
      formatObjects({
        CommonPrefixes: [{ Prefix: 'a/' }],
        Contents: [{ Key: 'b.txt', Size: 12, LastModified: '2026-09-08T00:01:02.000Z' }],
      }),
    ).toEqual(['                           PRE a/', '2026-09-08 00:01:02         12 b.txt']);
  });

  it('handles an empty listing', () => {
    expect(formatObjects({})).toEqual([]);
  });
});

// Records what the signed request looked like, and answers every command the same way
function recorder(body = '{}') {
  const seen: RegionRequest[] = [];
  return {
    seen,
    async dispatch(request: RegionRequest) {
      seen.push(request);
      return {
        status: 200,
        headers: { 'content-type': 'application/x-amz-json-1.0' },
        body: new TextEncoder().encode(body),
      };
    },
  };
}

describe('awsCli against a stub', () => {
  it('needs nothing but a dispatch, so no region has to boot', async () => {
    const aws = awsCli(recorder('{"QueueUrl":"http://stub/orders"}'));
    const created = await aws('sqs create-queue --queue-name orders');
    expect(JSON.parse(created.stdout).QueueUrl).toBe('http://stub/orders');
  });
});

describe('caller-supplied clients', () => {
  it('serves a command from an injected module, with nothing to import', async () => {
    const region = recorder();
    // A name no package is published under, so only the map can answer for it
    const aws = awsCli(region, { modules: { teapot: await import('@aws-sdk/client-sqs') } });

    expect((await aws('teapot list-queues')).code).toBe(0);
    expect(region.seen).toHaveLength(1);
  });

  it('signs with the credentials it is given', async () => {
    const region = recorder();
    const aws = awsCli(region, {
      client: { credentials: { accessKeyId: 'node-7', secretAccessKey: 'shh' } },
    });

    await aws('sqs create-queue --queue-name orders');
    expect(region.seen[0].headers.authorization).toContain('Credential=node-7/');
  });

  it('answers an alias from the module its resolved name is keyed by', async () => {
    const region = recorder();
    const aws = awsCli(region, { modules: { s3: await import('@aws-sdk/client-s3') } });

    expect((await aws('s3api create-bucket --bucket notes')).code).toBe(0);
    expect(region.seen[0].path).toBe('/notes/');
  });

  it('keeps path-style addressing under a caller-supplied client', async () => {
    const region = recorder();
    // forcePathStyle is the one thing `client` must not be able to take away
    const aws = awsCli(region, {
      client: { endpoint: 'http://region.test:9999', forcePathStyle: false },
    });

    await aws('s3api put-object --bucket notes --key hello.txt --body hi');
    expect(region.seen[0].path).toContain('/notes/hello.txt');
    expect(region.seen[0].headers.host).toBe('region.test:9999');
  });

  it('names both remedies for a service it cannot reach', async () => {
    const aws = awsCli(recorder());
    const result = await aws('s4 list-buckets');
    expect(result.stderr).toContain('npm install @aws-sdk/client-s4');
    expect(result.stderr).toContain("modules: { s4: await import('@aws-sdk/client-s4') }");
  });

  // import.meta.resolve decides wherever it exists, which is Node and every browser since
  // 2023; this is the fallback for a host that resolves modules itself
  it('reads a loader that names no code, as Vivari does not', () => {
    expect(unresolvable(new Error("Cannot find module '@aws-sdk/client-bogus' from '/bin'"))).toBe(
      true,
    );
    expect(
      unresolvable(Object.assign(new Error('whatever'), { code: 'ERR_MODULE_NOT_FOUND' })),
    ).toBe(true);
    // A client that is installed and threw while evaluating keeps its own error
    expect(unresolvable(new TypeError('x is not a function'))).toBe(false);
  });

  it('refuses an unlisted service without importing, since modules are the whole world', async () => {
    const aws = awsCli(recorder(), {
      modules: { s3: await import('@aws-sdk/client-s3'), sqs: await import('@aws-sdk/client-sqs') },
    });
    const result = await aws('bogusservice list-things');

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown service "bogusservice"');
    // The list comes from the usage text under it, named once
    expect(result.stderr).toContain('services: s3, s3api, sqs');
    // The advice a host that bundles cannot act on
    expect(result.stderr).not.toContain('npm install');
    expect(result.stderr).not.toContain('Cannot find module');
  });

  it('lists the services it was given, and the host note, in its usage', async () => {
    const aws = awsCli(recorder(), {
      modules: { s3: await import('@aws-sdk/client-s3') },
      note: 'Credentials come from the environment this shell was given.',
    });
    const { stdout } = await aws('help');

    expect(stdout).toContain('services: s3, s3api');
    expect(stdout).toContain('Credentials come from the environment this shell was given.');
    expect(stdout).not.toContain('npm install');
    expect(stdout).not.toContain('@aws-sdk/client-<service>');
  });

  it('still offers the open list when no modules are given', async () => {
    const { stdout } = await awsCli(recorder())('help');
    expect(stdout).toContain('@aws-sdk/client-<service>');
  });
});

describe('awsCli against a region', () => {
  let region: Region;
  let aws: AwsCli;

  beforeAll(async () => {
    region = await createRegion();
    aws = awsCli(region);
  }, 30_000);

  afterAll(async () => {
    await region?.stop();
  });

  it('runs an s3api round trip', async () => {
    expect((await aws('s3api create-bucket --bucket notes')).code).toBe(0);
    await aws(['s3api', 'put-object', '--bucket', 'notes', '--key', 'hello.txt', '--body', 'hi']);
    const listed = await aws('s3api list-objects-v2 --bucket notes');
    expect(JSON.parse(listed.stdout).Contents[0].Key).toBe('hello.txt');
    const read = await aws('s3api get-object --bucket notes --key hello.txt');
    expect(read.stdout).toContain('hi');
  });

  it('sends and receives an SQS message', async () => {
    const created = await aws('sqs create-queue --queue-name orders');
    const { QueueUrl } = JSON.parse(created.stdout);
    await aws(['sqs', 'send-message', '--queue-url', QueueUrl, '--message-body', '{"id": 1}']);
    const received = await aws(`sqs receive-message --queue-url ${QueueUrl}`);
    expect(JSON.parse(received.stdout).Messages[0].Body).toBe('{"id": 1}');
  });

  it('reaches a service the library never names, given its client', async () => {
    // sns is in neither the package's code nor its tests, but its client is installed here
    const result = await aws('sns create-topic --name alerts');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).TopicArn).toContain('alerts');
  });

  it('names the client to install for a service it cannot reach', async () => {
    const result = await aws('s4 list-buckets');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('npm install @aws-sdk/client-s4');
  });

  it('reports an unknown operation with the reference page', async () => {
    const result = await aws('sqs send-massage --queue-url http://q');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown operation "send-massage"');
    expect(result.stderr).toContain('docs.aws.amazon.com/cli/latest/reference/sqs/');
  });

  it('passes a region denial through as the CLI would', async () => {
    const result = await aws('s3api get-object --bucket notes --key absent.txt');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('NoSuchKey');
  });

  it('throws instead of returning a code when asked', async () => {
    const strict = awsCli(region, { throwOnError: true });
    await expect(strict('sqs nonsense')).rejects.toBeInstanceOf(CliError);
  });

  it('runs the s3 verbs against local files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pocket-region-cli-'));
    const local = path.join(directory, 'note.txt');
    await writeFile(local, 'typed in a shell');

    expect((await aws('s3 mb s3://shelf')).stdout).toBe('make_bucket: shelf\n');
    expect((await aws(`s3 cp ${local} s3://shelf/`)).stdout).toContain(
      'upload: ' + local + ' to s3://shelf/note.txt',
    );
    const listed = await aws('s3 ls s3://shelf');
    expect(listed.stdout).toContain('note.txt');

    const back = path.join(directory, 'back.txt');
    await aws(`s3 cp s3://shelf/note.txt ${back}`);
    expect(await readFile(back, 'utf8')).toBe('typed in a shell');

    expect((await aws('s3 rm s3://shelf/note.txt')).stdout).toBe('delete: s3://shelf/note.txt\n');
    expect((await aws('s3 ls s3://shelf')).stdout).toBe('');
    expect((await aws('s3 ls')).stdout).toContain('shelf');
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it('reads and writes through a files adapter, as a page would', async () => {
    const stored = new Map<string, Uint8Array>();
    const paged = awsCli(region, {
      files: {
        async read(name) {
          return stored.get(name) ?? new TextEncoder().encode('from the page');
        },
        async write(name, bytes) {
          stored.set(name, bytes);
        },
      },
    });
    await paged('s3 mb s3://pages');
    await paged('s3 cp upload.txt s3://pages/hello.txt');
    await paged('s3 cp s3://pages/hello.txt downloaded.txt');
    expect(new TextDecoder().decode(stored.get('downloaded.txt'))).toBe('from the page');
  });

  it('names the s3 verbs it takes', async () => {
    const result = await aws('s3 sync ./a s3://b');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown s3 command "sync" - s3 takes cp, ls, mb, rm');
  });

  it('answers help without touching the region', async () => {
    expect((await aws('help')).stdout).toContain('usage: aws <service> <operation>');
  });
});
