import type { Files } from 'pocket-region/browser';

// The page's files, which the terminal's local paths name: the zips a deploy builds, and
// whatever s3 cp reads or writes
const stored = new Map<string, Uint8Array>();

export const files: Files = {
  async read(path) {
    const bytes = stored.get(path);
    if (!bytes) throw new Error(`no such file: ${path}`);
    return bytes;
  },
  async write(path, bytes) {
    stored.set(path, bytes);
  },
};
