import { defineConfig } from 'vitepress';

// GitHub Pages serves a project site under /<repo>/. Override with DOCS_BASE for a custom domain.
const base = process.env.DOCS_BASE ?? '/kamui/';

export default defineConfig({
  title: 'Kamui',
  description: 'Embedded Starknet wallet with social login, session keys and sponsored transactions.',
  base,
  cleanUrls: true,
  lastUpdated: true,
  // docs/legal is the beta's terms and privacy notice, not developer docs; snippets/ are included
  // into pages as snippets; decisions/ holds internal proposals awaiting a team decision.
  srcExclude: ['legal/**', 'snippets/**', 'decisions/**', 'README.md'],
  head: [['meta', { name: 'theme-color', content: '#e2502f' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Examples', link: '/examples/react' },
      { text: 'Native', link: '/native/overview' },
      { text: 'Reference', link: '/reference/sdk' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Quickstart', link: '/guide/quickstart' },
          { text: 'Sessions', link: '/guide/sessions' },
          { text: 'Sponsorship', link: '/guide/sponsorship' },
          { text: 'Status and limitations', link: '/guide/limitations' },
        ],
      },
      {
        text: 'Examples',
        items: [
          { text: 'React', link: '/examples/react' },
          { text: 'Svelte', link: '/examples/svelte' },
          { text: 'Node.js', link: '/examples/node' },
        ],
      },
      {
        text: 'Native',
        items: [{ text: 'Overview', link: '/native/overview' }],
      },
      {
        text: 'Reference',
        items: [
          { text: 'SDK (app side)', link: '/reference/sdk' },
          { text: 'Keychain protocol', link: '/reference/protocol' },
          { text: 'Errors', link: '/reference/errors' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/starknet-innovation/kamui' }],
    editLink: {
      pattern: 'https://github.com/starknet-innovation/kamui/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    footer: { message: 'Development preview on Starknet Sepolia. Not audited. MIT licensed.' },
  },
});
