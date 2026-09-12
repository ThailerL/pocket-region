import { commandFor, type Services } from './dispatch.ts';
import { UsageError } from './errors.ts';

// Local paths only exist where something can read and write them: Node supplies this by
// itself, a page has to be given one
export type Files = {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
};

export type S3Uri = { Bucket: string; Key: string };

export function parseS3Uri(value?: string): S3Uri | undefined {
  if (!value?.startsWith('s3://')) return undefined;
  const rest = value.slice('s3://'.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return { Bucket: rest, Key: '' };
  return { Bucket: rest.slice(0, slash), Key: rest.slice(slash + 1) };
}

const stamp = (date?: string | Date) =>
  date ? new Date(date).toISOString().slice(0, 19).replace('T', ' ') : '';

type Bucket = { Name?: string; CreationDate?: string | Date };
type S3Object = { Key?: string; Size?: number; LastModified?: string | Date };

export function formatBuckets(buckets: Bucket[] = []) {
  return buckets.map((bucket) => `${stamp(bucket.CreationDate)} ${bucket.Name}`);
}

export function formatObjects({
  CommonPrefixes = [],
  Contents = [],
}: {
  CommonPrefixes?: { Prefix?: string }[];
  Contents?: S3Object[];
}) {
  return [
    ...CommonPrefixes.map((prefix) => `${' '.repeat(27)}PRE ${prefix.Prefix}`),
    ...Contents.map(
      (object) => `${stamp(object.LastModified)} ${String(object.Size).padStart(10)} ${object.Key}`,
    ),
  ];
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

// The verbs are conveniences over s3api, so the service is bound once and they name operations
type S3 = (operation: string, params: object) => Promise<Record<string, unknown>>;

async function localFiles(given?: Files): Promise<Files> {
  if (given) return given;
  try {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises');
    return { read: (path) => fs.readFile(path), write: (path, bytes) => fs.writeFile(path, bytes) };
  } catch {
    throw new UsageError(
      'a local path needs somewhere to read and write: pass awsCli(region, { files })',
      's3',
    );
  }
}

type Verb = (s3: S3, rest: string[], files?: Files) => Promise<string[]>;

const list: Verb = async (s3, [target]) => {
  if (!target) {
    const { Buckets } = await s3('ListBuckets', {});
    return formatBuckets(Buckets as Bucket[]);
  }
  const uri = parseS3Uri(target);
  if (!uri) throw new UsageError(`"${target}" is not an s3:// URI`, 's3');
  const listing = await s3('ListObjectsV2', {
    Bucket: uri.Bucket,
    Prefix: uri.Key,
    Delimiter: '/',
  });
  return formatObjects(listing);
};

const copy: Verb = async (s3, [from, to], files) => {
  if (!from || !to) throw new UsageError('cp needs a source and a destination', 's3');
  const source = parseS3Uri(from);
  const destination = parseS3Uri(to);

  if (!destination) {
    if (!source) throw new UsageError('cp needs at least one s3:// path', 's3');
    const { Body } = await s3('GetObject', source);
    const bytes = await (Body as { transformToByteArray(): Promise<Uint8Array> })
      .transformToByteArray();
    await (await localFiles(files)).write(to, bytes);
    return [`download: ${from} to ${to}`];
  }

  // A destination naming only a bucket, or ending in /, keeps the source's file name
  const Key =
    destination.Key && !destination.Key.endsWith('/')
      ? destination.Key
      : `${destination.Key}${fileName(from)}`;
  const target = `s3://${destination.Bucket}/${Key}`;

  if (source) {
    const CopySource = `${source.Bucket}/${source.Key}`;
    await s3('CopyObject', { Bucket: destination.Bucket, Key, CopySource });
    return [`copy: ${from} to ${target}`];
  }
  const Body = await (await localFiles(files)).read(from);
  await s3('PutObject', { Bucket: destination.Bucket, Key, Body });
  return [`upload: ${from} to ${target}`];
};

const makeBucket: Verb = async (s3, [target]) => {
  const uri = parseS3Uri(target);
  if (!uri?.Bucket) throw new UsageError('mb needs an s3://bucket path', 's3');
  await s3('CreateBucket', { Bucket: uri.Bucket });
  return [`make_bucket: ${uri.Bucket}`];
};

const remove: Verb = async (s3, [target]) => {
  const uri = parseS3Uri(target);
  if (!uri?.Key) throw new UsageError('rm needs an s3://bucket/key path', 's3');
  await s3('DeleteObject', uri);
  return [`delete: ${target}`];
};

// Conveniences over s3api operations, as they are in the real CLI
const VERBS: Record<string, Verb> = { cp: copy, ls: list, mb: makeBucket, rm: remove };

export async function runS3Verb(argv: string[], services: Services, files?: Files) {
  const [verb, ...rest] = argv;
  const run = verb ? VERBS[verb] : undefined;
  if (!run) {
    throw new UsageError(
      `unknown s3 command "${verb ?? ''}" - s3 takes ${Object.keys(VERBS).join(', ')}`,
      's3',
    );
  }
  const client = await services.client('s3api');
  const s3: S3 = async (operation, params) => {
    const Command = await commandFor('s3api', operation, services);
    return client.send(new Command(params));
  };
  const lines = await run(s3, rest, files);
  return lines.map((line) => `${line}\n`).join('');
}
