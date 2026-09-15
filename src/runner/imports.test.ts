import { describe, expect, it } from 'vitest';
import { IMPORT, rewriteImports } from './imports.ts';

const load = (specifier: string) => `await ${IMPORT}("${specifier}")`;

describe('rewriteImports', () => {
  it.each([
    ["import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';", `const { S3Client, PutObjectCommand } = ${load('@aws-sdk/client-s3')};`],
    ["import { zipSync as zip } from 'fflate';", `const { zipSync: zip } = ${load('fflate')};`],
    ["import * as s3 from '@aws-sdk/client-s3';", `const s3 = ${load('@aws-sdk/client-s3')};`],
    ["import fflate from 'fflate';", `const { default: fflate } = ${load('fflate')};`],
    ["import fflate, { zipSync } from 'fflate';", `const { default: fflate, zipSync } = ${load('fflate')};`],
    ["import fflate, * as all from 'fflate';", `const all = ${load('fflate')}; const fflate = all.default;`],
    ["import 'fflate';", `${load('fflate')};`],
    ['import { a } from "double"', `const { a } = ${load('double')};`],
  ])('rewrites %s', (source, expected) => {
    expect(rewriteImports(source).code).toBe(expected);
  });

  it('keeps the line count of a multi-line import, so later lines keep their numbers', () => {
    const source = "import {\n  S3Client,\n  PutObjectCommand,\n} from '@aws-sdk/client-s3';\nthrow new Error('line 5');";
    const { code } = rewriteImports(source);
    expect(code.split('\n')).toHaveLength(5);
    expect(code.split('\n')[4]).toBe("throw new Error('line 5');");
  });

  it('rewrites a dynamic import of a literal, and lists the specifiers', () => {
    const source = "import { a } from 'x';\nconst y = await import('y');\nconst again = await import(\"x\");";
    expect(rewriteImports(source)).toEqual({
      code: `const { a } = ${load('x')};\nconst y = await ${IMPORT}("y");\nconst again = await ${IMPORT}("x");`,
      specifiers: ['x', 'y', 'x'],
    });
  });

  it('leaves code without imports alone', () => {
    const source = "const important = 'import { no } from \"here\"';\nconsole.log(important, import.meta);";
    expect(rewriteImports(source)).toEqual({ code: source, specifiers: [] });
  });

  it('refuses an export', () => {
    expect(() => rewriteImports('export const a = 1;')).toThrow('cannot export');
  });

  it('refuses a dynamic import of anything but a literal', () => {
    expect(() => rewriteImports('const name = "x";\nawait import(name);')).toThrow('literal specifier');
  });
});
