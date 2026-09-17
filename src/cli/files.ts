import { UsageError } from './errors.ts';
import type { MemberKind } from './schema.ts';

// Local paths only exist where something can read and write them: Node supplies this by
// itself, a page has to be given one
export type Files = {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
};

let node: Promise<Files> | undefined;

export async function localFiles(given: Files | undefined, service: string): Promise<Files> {
  if (given) return given;
  try {
    return await (node ??= import(/* @vite-ignore */ 'node:fs/promises').then((fs) => ({
      read: (path) => fs.readFile(path),
      write: (path, bytes) => fs.writeFile(path, bytes),
    })));
  } catch {
    node = undefined;
    throw new UsageError(
      'a local path needs somewhere to read and write: pass awsCli(region, { files })',
      service,
    );
  }
}

// A value written as a path is read from the file, as the real CLI reads it: fileb:// as
// the bytes a blob takes, file:// as text. Anything else is not a file
export async function fileValue(value: string, kind: MemberKind, files: Files | undefined, service: string) {
  const match = /^(fileb?):\/\/(.*)$/s.exec(value);
  if (!match || (match[1] === 'fileb' && kind !== 'blob')) return undefined;
  const bytes = await (await localFiles(files, service)).read(match[2]!);
  return match[1] === 'fileb' ? bytes : new TextDecoder().decode(bytes);
}
