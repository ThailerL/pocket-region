import { describe, expect, it } from 'vitest';
import { stripTypes } from './strip.ts';

describe('stripTypes', () => {
  it('leaves plain JavaScript as it was', () => {
    const source = `import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import 'fflate';

const s3 = new S3Client({});
await s3.send(new CreateBucketCommand({ Bucket: 'photos' }));
console.log(1 < 2, 3 > 2, (a = 1) => a);`;
    expect(stripTypes(source)).toBe(source);
  });

  it('keeps an import nothing uses, since importing runs the module', () => {
    const source = "import { S3Client } from '@aws-sdk/client-s3';\nconsole.log(1);";
    expect(stripTypes(source)).toBe(source);
  });

  it('removes types, type-only imports, and TypeScript-only syntax, keeping the line count', () => {
    const source = `import type { Bucket } from '@aws-sdk/client-s3';
import { type Owner, S3Client } from '@aws-sdk/client-s3';
interface Row { name: string }
enum Kind { Table = 'table' }
const rows = [{ name: 'a' }] satisfies Row[];
const first = <Row>rows[0];
const name = (first as Row).name!;
function label<const T extends string>(value: T): string { return value; }
console.log(new S3Client({}), Kind.Table, label(name));`;
    const stripped = stripTypes(source);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
    expect(stripped).not.toMatch(/\b(interface|satisfies|as Row|Bucket|Owner)\b|<Row>|: string/);
    expect(stripped.split('\n')[1]).toBe("import { S3Client } from '@aws-sdk/client-s3';");
    expect(new Function('S3Client', stripped.split('\n').slice(2).join('\n'))).toBeTypeOf('function');
  });

  it('throws a SyntaxError with the position', () => {
    expect(() => stripTypes('const x: = 1;')).toThrow(/Unexpected token \(1:10\)/);
  });
});
