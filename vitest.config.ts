import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, type Plugin } from 'vitest/config';

// Vitest routes import() through a page-only global; workers started Vite's way get this stub, ours don't
const workerRunnerStub = (): Plugin => ({
  name: 'pocket-region:worker-runner-stub',
  transform(code, id) {
    if (!/\/src\/(region|runner)\/worker\.ts$/.test(id)) return;
    return { code: `globalThis.__vitest_browser_runner__ ??= { wrapDynamicImport: (f) => f() };\n${code}`, map: null };
  },
});

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/browser.test.ts', 'src/runner.test.ts'],
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
          include: [
            'src/browser.test.ts',
            'src/lambda/lambda.test.ts',
            'src/region.test.ts',
            'src/request-handler.test.ts',
            'src/runner.test.ts',
            'src/services.test.ts',
            'src/with-region.test.ts',
          ],
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
