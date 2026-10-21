// Builds the demos as a static site in demos/dist:
//   1. bundle+run tools/gen-entry.ts (node) -> demos/gen/*.gen.js
//   2. bundle each page's main (browser, iife) -> demos/dist/*-app.js
//   3. copy the pages alongside
// Open demos/dist/index.html directly, or serve the folder (GitHub Pages).

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const demos = new URL('../', import.meta.url).pathname;
const gen = join(demos, 'gen');
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

mkdirSync(gen, { recursive: true });
const tmp = join(gen, '.gen-entry.mjs');
await build({
  entryPoints: [join(demos, 'tools/gen-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: tmp,
  plugins: [embedSources],
  loader,
});
try {
  await import(tmp);
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
    plugins: [embedSources],
    loader,
    outfile: join(dist, outfile),
  });
await page('main.ts', 'app.js');
await page('tiger-main.ts', 'tiger-app.js');
await page('strokes-main.ts', 'strokes-app.js');
await page('paint-main.ts', 'paint-app.js');
for (const f of readdirSync(demos)) if (f.endsWith('.html')) copyFileSync(join(demos, f), join(dist, f));
console.log('demos/dist written — open index.html (text), tiger.html, strokes.html, paint.html');
