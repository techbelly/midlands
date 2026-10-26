// Builds the demos as a static site in demos/dist:
//   1. bundle tools/nile-plugin.ts (node), which compiles *.nl-lib imports
//   2. bundle each page's main (browser, iife) -> demos/dist/*-app.js
//   3. render the pages in demos/pages/ through the shared shell (tools/shell.mjs)
// Open demos/dist/index.html directly, or serve the folder (GitHub Pages).

import { build } from 'esbuild';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { renderPage } from './shell.mjs';
import { dirname, join } from 'node:path';

const demos = new URL('../', import.meta.url).pathname;
const dist = join(demos, 'dist');

// Every bundle embeds source text instead of reading it from disk: each
// source.js (umgeni's grammar and semantics, mooi's grammar) has a
// source.browser.ts twin importing the same files as text. So the compiler
// itself runs in the browser (the paint page) and bundled node code needs
// no files.
const embedSources = {
  name: 'embed-sources',
  setup(b) {
    b.onResolve({ filter: /(^|\/)source\.js$/ }, (args) => ({
      path: join(args.resolveDir, dirname(args.path), 'source.browser.ts'),
    }));
  },
};
const loader = { '.svg': 'text', '.ohm': 'text', '.nl': 'text', '.mooi': 'text', '.ttf': 'binary' };

// The plugin runs umgeni's compiler, which is TypeScript: bundle it for node
// first, then load it.
const tmp = join(demos, 'tools/.nile-plugin.mjs');
await build({
  entryPoints: [join(demos, 'tools/nile-plugin.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: tmp,
  plugins: [embedSources],
  loader,
});
let nile;
try {
  nile = (await import(tmp)).nilePlugin(new URL('../../', import.meta.url));
} finally {
  rmSync(tmp);
}

rmSync(dist, { recursive: true, force: true });
const page = async (entry, outfile) =>
  build({
    entryPoints: [join(demos, entry)],
    bundle: true,
    format: 'iife',
    minify: true,
    plugins: [embedSources, nile],
    loader,
    outfile: join(dist, outfile),
  });
await page('main.ts', 'app.js');
await page('tiger-main.ts', 'tiger-app.js');
await page('strokes-main.ts', 'strokes-app.js');
await page('paint-main.ts', 'paint-app.js');
await page('samples-main.ts', 'samples-app.js');
for (const f of readdirSync(join(demos, 'pages'))) writeFileSync(join(dist, f), renderPage(f, readFileSync(join(demos, 'pages', f), 'utf8')));
console.log('demos/dist written — open index.html (text), tiger.html, strokes.html, paint.html, samples.html');
