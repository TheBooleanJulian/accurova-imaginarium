// Builds the browser-only demo as ONE self-contained HTML fragment (JS, CSS and
// fonts inlined) for hosting as a single static page, e.g. a shared preview link.
//   node scripts/build-demo.mjs  →  .demo/accurova-imaginarium-demo.html
import { build } from 'vite';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve('.demo/dist');
await build({
  mode: 'production',
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
  build: {
    outDir: out,
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true, manualChunks: undefined } },
  },
  logLevel: 'warn',
});

const assets = path.join(out, 'assets');
const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith('.js'));
const css = files.filter((f) => f.endsWith('.css'));
const fontMime = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };
const inlineUrls = (text) =>
  text.replace(/url\((["']?)(?:\.\/|\/assets\/)?([^"')]+\.(woff2?|ttf))\1\)/g, (m, q, file, ext) => {
    const p = path.join(assets, path.basename(file));
    try {
      return `url(data:${fontMime[ext]};base64,${readFileSync(p).toString('base64')})`;
    } catch {
      return m;
    }
  });

const styles = css.map((f) => `<style>${inlineUrls(readFileSync(path.join(assets, f), 'utf8'))}</style>`).join('\n');
const scripts = js.map((f) => `<script type="module">${readFileSync(path.join(assets, f), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`).join('\n');
const favicon = readFileSync('public/favicon.svg', 'utf8');

const page = `<title>Accurova Imaginarium</title>
<meta name="theme-color" content="#050508">
<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(favicon).toString('base64')}">
<style>:root{color-scheme:dark}html,body{background:#050508;color:#e6eaf0}</style>
${styles}
<div id="root"></div>
${scripts}
`;
mkdirSync('.demo', { recursive: true });
const dest = '.demo/accurova-imaginarium-demo.html';
writeFileSync(dest, page);
console.log(`${dest}  ${(page.length / 1024 / 1024).toFixed(2)} MB, ${js.length} script(s), ${css.length} stylesheet(s)`);
