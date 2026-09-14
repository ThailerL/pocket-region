import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/browser.test.ts'],
        },
      },
      {
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
          include: ['src/browser.test.ts', 'src/region.test.ts', 'src/request-handler.test.ts', 'src/services.test.ts'],
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
