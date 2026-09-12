// Serves the repo so demo/index.html can reach dist/ and vendor/. Run `npm run build` and
// `npm run vendor` first; both are gitignored, so this never serves a stale checkout.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8000);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
};

for (const required of ['dist/browser.js', 'vendor/meta.json']) {
  if (!fs.existsSync(path.join(ROOT, required))) {
    process.stderr.write(`[demo] ${required} is missing: run npm run build and npm run vendor\n`);
    process.exit(1);
  }
}

const server = http.createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  // The page's asset paths are relative, so it has to be served from the root here, the way
  // it sits at the root of the Pages artifact
  if (pathname.startsWith('/demo')) {
    response.writeHead(302, { location: '/' }).end();
    return;
  }
  const file = path.join(ROOT, pathname === '/' ? 'demo/index.html' : decodeURIComponent(pathname));
  if (!file.startsWith(ROOT) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end(`no ${pathname}\n`);
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});

server.listen(PORT, () => {
  process.stdout.write(`[demo] http://localhost:${PORT}\n`);
});
