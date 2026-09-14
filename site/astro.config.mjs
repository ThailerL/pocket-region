import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { importMap } from './src/import-map.mjs';

export default defineConfig({
  site: 'https://pocket-region.dev',
  integrations: [
    starlight({
      title: 'Pocket Region',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ThailerL/pocket-region' }],
      head: [{ tag: 'script', attrs: { type: 'importmap' }, content: JSON.stringify(importMap) }],
      sidebar: [
        { slug: 'docs' },
        { slug: 'docs/create-region' },
        { slug: 'docs/clients' },
        { slug: 'docs/lambda' },
        { slug: 'docs/cli' },
        { slug: 'docs/services' },
        { slug: 'docs/how-it-works' },
      ],
    }),
  ],
});
