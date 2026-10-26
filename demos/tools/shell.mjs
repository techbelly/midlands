// The shell every demo page shares. A page in demos/pages/ is a fragment of
// named sections; this assembles them in one fixed order, with the nav, the
// styles and the footer written once, so the pages cannot drift apart:
//
//   nav · title (+ one-line lede) · renderer switcher · demo · rendering
//   performance · how to use · rendering stats · Nile pipeline · description
//
// A fragment:
//   <meta name="width" content="720">          page width in px (optional)
//   <meta name="script" content="tiger-app.js"> the page's bundle
//   <style>…</style>                            page-specific styles (optional)
//   <h1>Tiger</h1>
//   <section slot="lede">one sentence</section>
//   <section slot="switcher">…</section>        optional (strokes has none)
//   <section slot="demo">…</section>
//   <section slot="help">…</section>
//   <section slot="stats">…</section>           static lines; #stats is added
//   <section slot="pipeline">…</section>        extra panels; #nile is added
//   <section slot="description">…</section>
//
// Every page gets the same ids: #perf (the live line under the picture),
// #stats (the live counts) and #nile (the quoted pipeline).

const PAGES = [
  ['index.html', 'text'],
  ['tiger.html', 'tiger'],
  ['strokes.html', 'strokes'],
  ['paint.html', 'paint'],
  ['samples.html', 'samples'],
];

const SHARED_CSS = `
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.2rem; margin-bottom: 0.2rem; }
  nav a { margin-right: 1rem; }
  canvas { border: 1px solid #ccc; width: 100%; background: #fff; }
  section { margin: 0.9rem 0; }
  .lede { margin: 0 0 0.6rem; }
  .switcher { margin: 0.6rem 0; }
  .perf { color: #666; font-size: 0.9rem; font-variant-numeric: tabular-nums; margin: 0.4rem 0 0; min-height: 1.4em; white-space: pre-wrap; }
  .perf.err { color: #b42318; }
  .help { background: #eef4fb; border-radius: 4px; padding: 0.45rem 0.75rem; font-size: 0.9rem; }
  .stats { color: #777; font-size: 0.85rem; }
  .stats p { margin: 0.2rem 0; }
  #stats { color: #666; font-variant-numeric: tabular-nums; }
  .nile { background: #f6f6f3; border-left: 3px solid #c9c4b5; padding: 0.6rem 0.9rem; font: 12px/1.45 ui-monospace, Menlo, monospace; overflow-x: auto; margin: 0.6rem 0; }
  .pipeline details { margin: 0.5rem 0; }
  .pipeline summary { cursor: pointer; color: #555; }
  .pipeline .nile { margin-top: 0.4rem; }
  .description { color: #333; }
  footer { margin: 2rem 0 1rem; padding-top: 0.6rem; border-top: 1px solid #ddd; color: #777; font-size: 0.85rem; }
`;

const FOOTER = '<a href="https://github.com/techbelly/midlands">midlands on GitHub</a> — the Nile, the compiler and these demos.';

const nav = (file) =>
  '<nav>' + PAGES.map(([href, name]) => `<a href="${href}">${href === file ? `<b>${name}</b>` : name}</a>`).join(' ') + '</nav>';

function pick(fragment, re, what, file) {
  const m = fragment.match(re);
  if (!m) throw new Error(`${file}: missing ${what}`);
  return m[1].trim();
}
const meta = (fragment, name) => fragment.match(new RegExp(`<meta name="${name}" content="([^"]*)">`))?.[1];
const slot = (fragment, name) => fragment.match(new RegExp(`<section slot="${name}">([\\s\\S]*?)</section>`))?.[1].trim() ?? '';

export function renderPage(file, fragment) {
  const title = pick(fragment, /<h1>([\s\S]*?)<\/h1>/, '<h1>', file);
  const name = PAGES.find(([f]) => f === file)?.[1] ?? file.replace(/\.html$/, '');
  const script = meta(fragment, 'script') ?? `${name}-app.js`;
  const width = meta(fragment, 'width') ?? '720';
  const style = fragment.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const required = ['lede', 'demo', 'help', 'description'];
  for (const s of required) if (!slot(fragment, s)) throw new Error(`${file}: missing <section slot="${s}">`);
  const switcher = slot(fragment, 'switcher');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>midlands — ${name}</title>
<style>${SHARED_CSS}  body { max-width: ${width}px; }
${style}</style>
</head>
<body>
${nav(file)}
<h1>${title}</h1>
<p class="lede">${slot(fragment, 'lede')}</p>
${switcher ? `<section class="switcher">${switcher}</section>` : ''}
<section class="demo">
${slot(fragment, 'demo')}
<p class="perf" id="perf"></p>
</section>
<section class="help"><b>How to use:</b> ${slot(fragment, 'help')}</section>
<section class="stats">
<p id="stats"></p>
${slot(fragment, 'stats')}
</section>
<section class="pipeline">
<details><summary>See the Nile pipeline</summary>
<pre class="nile" id="nile"></pre>
</details>
${slot(fragment, 'pipeline')}
</section>
<section class="description">
${slot(fragment, 'description')}
</section>
<footer>${FOOTER}</footer>
<script src="${script}"></script>
</body>
</html>
`;
}
