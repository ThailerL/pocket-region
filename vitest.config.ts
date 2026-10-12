import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, type Plugin } from 'vitest/config';

// Vitest routes import() through a page-only global; workers started Vite's way get this stub, ours
// don't, nor does Pyodide when a Lambda environment's worker loads it from Vite's server
const workerRunnerStub = (): Plugin => ({
  name: 'pocket-region:worker-runner-stub',
  transform(code, id) {
    if (!/\/src\/.+\/[\w-]*worker\.ts$/.test(id) && !/\/node_modules\/pyodide\/pyodide\.mjs(\?|$)/.test(id)) return;
    return { code: `globalThis.__vitest_browser_runner__ ??= { wrapDynamicImport: (f) => f() };\n${code}`, map: null };
  },
});

// A URL under /fails-once/<anything>/ answers 503 the first time, then as the path after it would
const failsOnce = (): Plugin => {
  const asked = new Set<string>();
  return {
    name: 'pocket-region:fails-once',
    configureServer({ middlewares }) {
      middlewares.use((req, res, next) => {
        const path = /^\/fails-once\/[^/]+(\/.*)$/.exec(req.url ?? '')?.[1];
        if (path === undefined) return next();
        if (asked.has(req.url!)) {
          req.url = path;
          return next();
        }
        asked.add(req.url!);
        res.statusCode = 503;
        res.end();
      });
    },
  };
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          // A test file's name says where it runs: *.browser.test.ts in a page, *.shared.test.ts
          // in both, anything else here
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.browser.test.ts'],
        },
      },
      {
        plugins: [workerRunnerStub(), failsOnce()],
        resolve: {
          alias: [
            {
              find: /^(\.\.?\/)+testing\/region\.ts$/,
              replacement: fileURLToPath(new URL('src/testing/region.browser.ts', import.meta.url)),
            },
          ],
        },
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.ts', 'src/**/*.shared.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
          },
        },
      },
    ],
  },
});
