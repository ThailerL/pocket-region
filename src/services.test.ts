import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  FilterLogEventsCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { EventBridgeClient, PutEventsCommand, PutRuleCommand, PutTargetsCommand } from '@aws-sdk/client-eventbridge';
import {
  CreateAccessKeyCommand,
  CreateRoleCommand,
  CreateUserCommand,
  IAMClient,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateStreamCommand,
  GetRecordsCommand,
  GetShardIteratorCommand,
  KinesisClient,
  ListShardsCommand,
  PutRecordCommand,
} from '@aws-sdk/client-kinesis';
import { CreateKeyCommand, DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  PutBucketNotificationConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { CreateTopicCommand, PublishCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import { CreateActivityCommand, GetActivityTaskCommand, SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, GetParametersByPathCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Region } from './core.ts';
import { requestHandler } from './request-handler.ts';
import { bodies, clientConfig, createQueue, execute, finished, startExecution } from './test-clients.ts';
import { createTestRegion } from './test-region.ts';

let region: Region;
let config: ReturnType<typeof clientConfig>;
let sqs: SQSClient;
let sfn: SFNClient;

beforeAll(async () => {
  region = await createTestRegion();
  config = clientConfig({ requestHandler: requestHandler(region) });
  sqs = new SQSClient(config);
  sfn = new SFNClient(config);
}, 30_000);

afterAll(async () => {
  await region?.stop();
});

describe('services through the SDK', () => {
  it('sends an S3 object-created notification to an SQS queue', async () => {
    const s3 = new S3Client({ ...config, forcePathStyle: true });
    const { QueueUrl, QueueArn } = await createQueue(sqs, 'uploads');
    await s3.send(new CreateBucketCommand({ Bucket: 'photos' }));
    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: 'photos',
        NotificationConfiguration: { QueueConfigurations: [{ QueueArn, Events: ['s3:ObjectCreated:*'] }] },
      }),
    );
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'cat.jpg', Body: 'meow' }));
    const records = async () => (await bodies(sqs, QueueUrl)).flatMap((body) => body.Records ?? []);
    await expect
      .poll(records, { timeout: 5_000 })
      .toEqual([
        expect.objectContaining({
          eventSource: 'aws:s3',
          eventName: 'ObjectCreated:Put',
          s3: expect.objectContaining({ bucket: expect.objectContaining({ name: 'photos' }), object: expect.objectContaining({ key: 'cat.jpg' }) }),
        }),
      ]);
  });

  it('lists an S3 key with characters the SDK percent-encodes as it was put', async () => {
    const s3 = new S3Client({ ...config, forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: 'notes' }));
    await s3.send(new PutObjectCommand({ Bucket: 'notes', Key: 'a b/ü+?.txt', Body: 'hi' }));
    const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: 'notes' }));
    expect(Contents?.map((object) => object.Key)).toEqual(['a b/ü+?.txt']);
  });

  it('stores a secret and returns its latest version', async () => {
    const secrets = new SecretsManagerClient(config);
    await secrets.send(new CreateSecretCommand({ Name: 'db-password', SecretString: 'first' }));
    await secrets.send(new PutSecretValueCommand({ SecretId: 'db-password', SecretString: 'second' }));
    const { SecretString, VersionStages } = await secrets.send(new GetSecretValueCommand({ SecretId: 'db-password' }));
    expect(SecretString).toBe('second');
    expect(VersionStages).toEqual(['AWSCURRENT']);
  });

  it('stores parameters, decrypting a SecureString and listing by path', async () => {
    const ssm = new SSMClient(config);
    await ssm.send(new PutParameterCommand({ Name: '/app/api-key', Value: 'abc', Type: 'SecureString' }));
    await ssm.send(new PutParameterCommand({ Name: '/app/region', Value: 'us-east-1', Type: 'String' }));
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: '/app/api-key', WithDecryption: true }));
    expect(Parameter).toMatchObject({ Value: 'abc', Type: 'SecureString' });
    const { Parameters = [] } = await ssm.send(new GetParametersByPathCommand({ Path: '/app' }));
    expect(Parameters.map((parameter) => parameter.Name).sort()).toEqual(['/app/api-key', '/app/region']);
  });

  it('encrypts and decrypts with a KMS key', async () => {
    const kms = new KMSClient(config);
    const { KeyMetadata } = await kms.send(new CreateKeyCommand({}));
    const plaintext = new TextEncoder().encode('card number');
    const { CiphertextBlob } = await kms.send(new EncryptCommand({ KeyId: KeyMetadata!.KeyId, Plaintext: plaintext }));
    expect(CiphertextBlob).not.toEqual(plaintext);
    const { Plaintext, KeyId } = await kms.send(new DecryptCommand({ CiphertextBlob }));
    expect(new TextDecoder().decode(Plaintext)).toBe('card number');
    expect(KeyId).toBe(KeyMetadata!.Arn);
  });

  it('writes log events and filters them by pattern', async () => {
    const logs = new CloudWatchLogsClient(config);
    await logs.send(new CreateLogGroupCommand({ logGroupName: '/app/web' }));
    await logs.send(new CreateLogStreamCommand({ logGroupName: '/app/web', logStreamName: 'instance-1' }));
    const now = Date.now();
    await logs.send(
      new PutLogEventsCommand({
        logGroupName: '/app/web',
        logStreamName: 'instance-1',
        logEvents: [
          { timestamp: now, message: 'GET /health 200' },
          { timestamp: now + 1, message: 'GET /orders 500' },
        ],
      }),
    );
    const { events = [] } = await logs.send(new FilterLogEventsCommand({ logGroupName: '/app/web', filterPattern: '500' }));
    expect(events.map((event) => event.message)).toEqual(['GET /orders 500']);
  });

  it('reads back a record put on a Kinesis stream', async () => {
    const kinesis = new KinesisClient(config);
    await kinesis.send(new CreateStreamCommand({ StreamName: 'clicks', ShardCount: 1 }));
    await kinesis.send(new PutRecordCommand({ StreamName: 'clicks', PartitionKey: 'user-1', Data: new TextEncoder().encode('click') }));
    const { Shards } = await kinesis.send(new ListShardsCommand({ StreamName: 'clicks' }));
    const { ShardIterator } = await kinesis.send(
      new GetShardIteratorCommand({ StreamName: 'clicks', ShardId: Shards![0]!.ShardId, ShardIteratorType: 'TRIM_HORIZON' }),
    );
    const { Records = [] } = await kinesis.send(new GetRecordsCommand({ ShardIterator }));
    expect(Records.map((record) => new TextDecoder().decode(record.Data))).toEqual(['click']);
  });

  it('fans an SNS message out to an SQS subscription in the notification envelope', async () => {
    const sns = new SNSClient(config);
    const { QueueUrl, QueueArn } = await createQueue(sqs, 'order-emails');
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: 'orders' }));
    await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'sqs', Endpoint: QueueArn }));
    await sns.send(new PublishCommand({ TopicArn, Subject: 'placed', Message: 'order 42' }));
    await expect
      .poll(() => bodies(sqs, QueueUrl), { timeout: 5_000 })
      .toEqual([expect.objectContaining({ Type: 'Notification', TopicArn, Subject: 'placed', Message: 'order 42' })]);
  });

  it('runs a Step Functions execution to completion', async () => {
    const execution = await execute(sfn, 'greeter', {
      StartAt: 'Greet',
      States: { Greet: { Type: 'Pass', Result: { greeting: 'hello' }, End: true } },
    });
    expect(execution).toEqual({ status: 'SUCCEEDED', output: { greeting: 'hello' } });
  });

  // Map runs its items on a ThreadPoolExecutor, whose idle workers once froze the region
  it('runs a Step Functions Map state over every item', async () => {
    const execution = await execute(
      sfn,
      'labeller',
      {
        StartAt: 'Label',
        States: {
          Label: {
            Type: 'Map',
            ItemsPath: '$.items',
            ItemProcessor: { StartAt: 'Wrap', States: { Wrap: { Type: 'Pass', Parameters: { 'label.$': '$' }, End: true } } },
            End: true,
          },
        },
      },
      { items: ['a', 'b', 'c'] },
    );
    expect(execution).toEqual({ status: 'SUCCEEDED', output: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] });
  });

  it('holds a Step Functions execution for its Wait state', async () => {
    const started = Date.now();
    const execution = await execute(sfn, 'pause', { StartAt: 'Pause', States: { Pause: { Type: 'Wait', Seconds: 1, End: true } } });
    expect(execution.status).toBe('SUCCEEDED');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });

  it('resumes a Step Functions execution waiting for a task token when the token succeeds', async () => {
    const { QueueUrl } = await createQueue(sqs, 'approvals');
    const executionArn = await startExecution(sfn, 'approval', {
      StartAt: 'Ask',
      States: {
        Ask: {
          Type: 'Task',
          Resource: 'arn:aws:states:::sqs:sendMessage.waitForTaskToken',
          Parameters: { QueueUrl, MessageBody: { 'token.$': '$$.Task.Token' } },
          End: true,
        },
      },
    });
    let messages: { token: string }[] = [];
    await expect.poll(async () => (messages = await bodies(sqs, QueueUrl)).length, { timeout: 5_000 }).toBe(1);
    await sfn.send(new SendTaskSuccessCommand({ taskToken: messages[0]!.token, output: '{"approved":true}' }));
    expect(await finished(sfn, executionArn)).toEqual({ status: 'SUCCEEDED', output: { approved: true } });
  });

  it('hands a Step Functions activity task to a worker, and resumes with its result', async () => {
    const { activityArn } = await sfn.send(new CreateActivityCommand({ name: 'packer' }));
    const executionArn = await startExecution(sfn, 'pack', { StartAt: 'Pack', States: { Pack: { Type: 'Task', Resource: activityArn, End: true } } }, { box: 7 });
    const task = await sfn.send(new GetActivityTaskCommand({ activityArn }));
    expect(JSON.parse(task.input!)).toEqual({ box: 7 });
    await sfn.send(new SendTaskSuccessCommand({ taskToken: task.taskToken, output: '{"packed":7}' }));
    expect(await finished(sfn, executionArn)).toEqual({ status: 'SUCCEEDED', output: { packed: 7 } });
  });

  it('routes only the EventBridge events a rule matches to its SQS target', async () => {
    const events = new EventBridgeClient(config);
    const { QueueUrl, QueueArn } = await createQueue(sqs, 'large-orders');
    await events.send(
      new PutRuleCommand({
        Name: 'large-orders',
        EventPattern: JSON.stringify({ source: ['shop'], detail: { total: [{ numeric: ['>', 100] }] } }),
      }),
    );
    await events.send(new PutTargetsCommand({ Rule: 'large-orders', Targets: [{ Id: 'queue', Arn: QueueArn }] }));
    const { FailedEntryCount } = await events.send(
      new PutEventsCommand({
        Entries: [
          { Source: 'shop', DetailType: 'order placed', Detail: JSON.stringify({ total: 20 }) },
          { Source: 'shop', DetailType: 'order placed', Detail: JSON.stringify({ total: 250 }) },
        ],
      }),
    );
    expect(FailedEntryCount).toBe(0);
    await expect
      .poll(() => bodies(sqs, QueueUrl), { timeout: 5_000 })
      .toEqual([expect.objectContaining({ source: 'shop', 'detail-type': 'order placed', detail: { total: 250 } })]);
  });
});

const allow = (Action: string, Resource = '*') =>
  JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action, Resource }] });

type Keys = { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };

// A client of target acting as whoever the keys belong to, or as the root user without them
const configOf = (target: Region, keys?: Keys) =>
  clientConfig({
    requestHandler: requestHandler(target),
    ...(keys && { credentials: { accessKeyId: keys.AccessKeyId!, secretAccessKey: keys.SecretAccessKey!, sessionToken: keys.SessionToken } }),
  });

// A client acting as a new IAM user whose only policy is the one given
async function userConfig(target: Region, name: string, policy: string) {
  const iam = new IAMClient(configOf(target));
  await iam.send(new CreateUserCommand({ UserName: name }));
  await iam.send(new PutUserPolicyCommand({ UserName: name, PolicyName: 'only', PolicyDocument: policy }));
  const { AccessKey } = await iam.send(new CreateAccessKeyCommand({ UserName: name }));
  return configOf(target, AccessKey);
}

describe('IAM', () => {
  let enforcing: Region;

  beforeAll(async () => {
    enforcing = await createTestRegion({ enforceIam: true });
  }, 30_000);

  afterAll(async () => {
    await enforcing?.stop();
  });

  it('lets a default client do anything', async () => {
    await new S3Client(configOf(enforcing)).send(new CreateBucketCommand({ Bucket: 'root-bucket' }));
    await new IAMClient(configOf(enforcing)).send(new CreateUserCommand({ UserName: 'made-by-root' }));
  });

  it('denies an IAM user what its policy does not allow', async () => {
    await new S3Client(configOf(enforcing)).send(new CreateBucketCommand({ Bucket: 'uploads' }));
    const s3 = new S3Client(await userConfig(enforcing, 'uploader', allow('s3:PutObject', 'arn:aws:s3:::uploads/*')));
    await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'a.txt', Body: 'a' }));
    await expect(s3.send(new CreateBucketCommand({ Bucket: 'not-allowed' }))).rejects.toThrow(
      expect.objectContaining({ name: 'AccessDenied' }),
    );
  });

  it('denies an assumed role what its policy does not allow', async () => {
    const iam = new IAMClient(configOf(enforcing));
    const trust = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::000000000000:root' }, Action: 'sts:AssumeRole' }],
    });
    await iam.send(new CreateRoleCommand({ RoleName: 'storage', AssumeRolePolicyDocument: trust }));
    await iam.send(new PutRolePolicyCommand({ RoleName: 'storage', PolicyName: 'only', PolicyDocument: allow('s3:*') }));
    const { Credentials } = await new STSClient(configOf(enforcing)).send(
      new AssumeRoleCommand({ RoleArn: 'arn:aws:iam::000000000000:role/storage', RoleSessionName: 'test' }),
    );
    const session = configOf(enforcing, Credentials);
    await new S3Client(session).send(new CreateBucketCommand({ Bucket: 'role-bucket' }));
    await expect(new IAMClient(session).send(new CreateUserCommand({ UserName: 'not-allowed' }))).rejects.toThrow(
      expect.objectContaining({ name: 'AccessDenied' }),
    );
  });

  it('enforces nothing in a region without the option', async () => {
    const s3 = new S3Client(await userConfig(region, 'unchecked', allow('s3:PutObject', 'arn:aws:s3:::uploads/*')));
    await s3.send(new CreateBucketCommand({ Bucket: 'allowed-anyway' }));
  });
});
