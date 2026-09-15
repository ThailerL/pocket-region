import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { importMap } from './src/import-map.mjs';

export default defineConfig({
  site: 'https://pocket-region.dev',
  integrations: [
    starlight({
      title: 'Pocket Region',
      customCss: ['./src/styles/docs.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ThailerL/pocket-region' }],
      head: [
        { tag: 'script', attrs: { type: 'importmap' }, content: JSON.stringify(importMap) },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://pocket-region.dev/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
      ],
      sidebar: [
        { slug: 'docs' },
        { slug: 'docs/services' },
        { slug: 'docs/lambda' },
        { slug: 'docs/region' },
        { slug: 'docs/clients' },
        { slug: 'docs/cli' },
        { slug: 'docs/runner' },
        { slug: 'docs/how-it-works' },
      ],
    }),
  ],
});
