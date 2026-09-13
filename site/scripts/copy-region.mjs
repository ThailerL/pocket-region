// Copies the library's built dist/ and vendor/ into public/region/, served as-is and never
// bundled, so the site demonstrates the checkout it was built from

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const TARGET = path.resolve(fileURLToPath(new URL('../public/region/', import.meta.url)));

for (const required of ['dist/browser.js', 'vendor/meta.json']) {
  if (!fs.existsSync(path.join(REPO, required))) {
    process.stderr.write(`[site] ${required} is missing: run npm run vendor and npm run build at the repo root\n`);
    process.exit(1);
  }
}

fs.rmSync(TARGET, { recursive: true, force: true });
for (const directory of ['dist', 'vendor']) {
  fs.cpSync(path.join(REPO, directory), path.join(TARGET, directory), { recursive: true });
}
