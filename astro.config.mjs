import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import fs from 'node:fs';

// Lake pages with no reading at all are noindex,follow (src/pages/lake/[slug].astro) and
// stay out of the sitemap. Read after `npm run fetch`, so it matches the build's data.
const levels = JSON.parse(fs.readFileSync(new URL('./src/data/levels.json', import.meta.url), 'utf8'));
const lakes = JSON.parse(fs.readFileSync(new URL('./src/data/lakes.json', import.meta.url), 'utf8'));
const noDataLake = new Set(lakes.map((l) => l.slug).filter((slug) => {
  const r = levels[slug];
  return !r || (r.level_ft == null && r.pct_full == null);
}));
const isNoDataLake = (page) => {
  const m = /\/lake\/([a-z0-9-]+)\/?$/.exec(new URL(page).pathname);
  return !!(m && noDataLake.has(m[1]));
};

// lakelevelnow.com — static, SEO-first, live-data-first site on Cloudflare Workers.
// Static output (default) = fastest LCP, best Core Web Vitals, most crawlable.
// The weekly pipeline (scripts/fetch-levels.mjs) regenerates live USGS/CDEC readings
// into src/data/, the build renders them, and a GitHub Action deploys + pings IndexNow.
export default defineConfig({
  site: 'https://lakelevelnow.com',
  trailingSlash: 'ignore',
  build: {
    format: 'directory', // /lake/foo/ -> /lake/foo/index.html (clean URLs)
  },
  prefetch: {
    prefetchAll: true, // prefetch visible links -> faster nav, better CWV
    defaultStrategy: 'viewport',
  },
  integrations: [
    sitemap({
      // /almanac/thanks/ is a post-purchase page whose URL carries a live Stripe session
      // id. It must never be indexed; it also carries noindex, and this is the second lock.
      filter: (page) => !page.includes('/404') && !page.includes('/almanac/thanks') && !page.includes('/support/') && !isNoDataLake(page),
      changefreq: 'weekly',
      priority: 0.7,
    }),
    mdx(),
  ],
});
