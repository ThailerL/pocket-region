import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DOCS = new URL('../site/src/content/docs/docs/', import.meta.url);

// What the docs' import map serves in a page, with the library's Node entry standing in
const modules: Record<string, () => Promise<unknown>> = {
  'pocket-region/browser': () => import('./index.ts'),
  fflate: () => import('fflate'),
  '@aws-sdk/client-cloudwatch-logs': () => import('@aws-sdk/client-cloudwatch-logs'),
  '@aws-sdk/client-dynamodb': () => import('@aws-sdk/client-dynamodb'),
  '@aws-sdk/client-eventbridge': () => import('@aws-sdk/client-eventbridge'),
  '@aws-sdk/client-kinesis': () => import('@aws-sdk/client-kinesis'),
  '@aws-sdk/client-kms': () => import('@aws-sdk/client-kms'),
  '@aws-sdk/client-lambda': () => import('@aws-sdk/client-lambda'),
  '@aws-sdk/client-s3': () => import('@aws-sdk/client-s3'),
  '@aws-sdk/client-secrets-manager': () => import('@aws-sdk/client-secrets-manager'),
  '@aws-sdk/client-sns': () => import('@aws-sdk/client-sns'),
  '@aws-sdk/client-sqs': () => import('@aws-sdk/client-sqs'),
  '@aws-sdk/client-ssm': () => import('@aws-sdk/client-ssm'),
};

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;

const examples = readdirSync(DOCS)
  .filter((file) => file.endsWith('.mdx'))
  .flatMap((file) =>
    Array.from(readFileSync(new URL(file, DOCS), 'utf8').matchAll(/<Runnable>\s*```js\n([\s\S]*?)```\s*<\/Runnable>/g), (match, index) => ({
      name: `${file} example ${index + 1}`,
      code: match[1]!,
    })),
  );

async function run(code: string) {
  const lines: string[] = [];
  const console = { log: (...args: unknown[]) => lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')) };
  const body = code.replace(/^import\s*(\{[\s\S]*?\})\s*from\s*'([^']+)';/gm, "const $1 = await load('$2');");
  const load = (specifier: string) => {
    if (!(specifier in modules)) throw new Error(`the docs import ${specifier}: add it to this test and the site's import map`);
    return modules[specifier]!();
  };
  await new AsyncFunction('load', 'console', body)(load, console);
  return lines;
}

describe('runnable docs examples', () => {
  it('finds them', () => {
    expect(examples.length).toBeGreaterThan(10);
  });

  it.each(examples)('$name prints what it did', async ({ code }) => {
    expect(await run(code)).toMatchSnapshot();
  }, 60_000);
});
