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
        plugins: [workerRunnerStub()],
        resolve: {
          alias: [
            {
              find: /^\.\.?\/test-region\.ts$/,
              replacement: fileURLToPath(new URL('src/test-region.browser.ts', import.meta.url)),
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
            instances: [{ browser: 'chromium' }, { browser: 'firefox' }],
          },
        },
      },
    ],
  },
});
