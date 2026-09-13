import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Event source mappings need JSPI: Node before 24.20 hides it behind this flag, and Node 26 refuses it
    execArgv: typeof WebAssembly.Suspending === 'function' ? [] : ['--experimental-wasm-jspi'],
  },
});
