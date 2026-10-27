// esbuild plugin: a page imports a Nile library and gets it compiled.
//
//   import { nile } from './nl/vector.nl-lib';
//
// At bundle time the .nl-lib's sources are compiled by umgeni, and the import
// becomes a module exporting:
//   nile         the library API — nile.SvgFill({ … }).run(tokens), nile.types
//   nileWasm     the same, compiled to WebAssembly (pipelines in wasm, run by
//                the same runtime)
//   compileMs    how long the compile took (at build time)
//   sources      the library's Nile source texts, in manifest order: what a
//                page quotes, and what the paint page compiles with yours
//   <Name>IR     each fused process's IR as plain data, for the browser's GPU
//                lowering (e.g. RasterizePixelsIR)
// Every export is side-effect free, so a page pays only for what it imports.

import type { Plugin } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileLibraryFile, librarySources, librarySourceTexts } from '../src/sources.js';

export function nilePlugin(root: URL): Plugin {
  return {
    name: 'nile-library',
    setup(b) {
      b.onLoad({ filter: /\.nl-lib$/ }, (args) => {
        const manifest = pathToFileURL(args.path).href.slice(root.href.length);
        const t0 = performance.now();
        const library = compileLibraryFile(manifest, {}, root);
        const compileMs = performance.now() - t0;
        const wasm = compileLibraryFile(manifest, { target: 'wasm' }, root);
        if (library.unsupported.length > 0) {
          return { errors: [{ text: `${manifest}: unsupported processes: ${JSON.stringify(library.unsupported)}` }] };
        }
        const fused = library.ir.processes.filter((p) => p.k === 'fused');
        return {
          contents: [
            "import * as rt from './umgeni/src/cpu/runtime.js';",
            `export const compileMs = ${compileMs.toFixed(1)};`,
            `export const sources = ${JSON.stringify(librarySourceTexts(manifest, root))};`,
            `export const nile = /* @__PURE__ */ rt.api(/* @__PURE__ */ (${library.source})(rt));`,
            `export const nileWasm = /* @__PURE__ */ rt.api(/* @__PURE__ */ (${wasm.source})(rt));`,
            ...fused.map((p) => `export const ${p.name}IR = ${JSON.stringify(p)};`),
          ].join('\n'),
          loader: 'js',
          resolveDir: fileURLToPath(root),
          watchFiles: librarySources(manifest, root).map((p) => fileURLToPath(new URL(p, root))),
        };
      });
    },
  };
}
