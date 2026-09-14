import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://pocket-region.dev',
  integrations: [
    starlight({
      title: 'Pocket Region',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ThailerL/pocket-region' }],
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
