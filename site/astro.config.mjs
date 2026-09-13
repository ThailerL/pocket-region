import { defineConfig } from 'astro/config';

export default defineConfig({
  // Until the landing page takes /
  redirects: { '/': '/demo' },
});
