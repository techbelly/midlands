// esbuild plugin: a page imports a Nile program and gets it compiled.
//
//   import { nile } from './nl/vector.program';
//
// At bundle time the .program's sources are compiled by umgeni, and the import
// becomes a module exporting:
//   nile         the program API — nile.SvgFill({ … }).run(tokens), nile.types
//   compileMs    how long the compile took (at build time)
//   <Name>IR     each fused process's IR as plain data, for the browser's GPU
//                lowering (e.g. Rasterize2IR)
// Every export is side-effect free, so a page pays only for what it imports.

import type { Plugin } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileProgramFile, programSources } from '../src/sources.js';

export function nilePlugin(root: URL): Plugin {
  return {
    name: 'nile-program',
    setup(b) {
      b.onLoad({ filter: /\.program$/ }, (args) => {
        const manifest = pathToFileURL(args.path).href.slice(root.href.length);
        const t0 = performance.now();
        const program = compileProgramFile(manifest, {}, root);
        const compileMs = performance.now() - t0;
        if (program.unsupported.length > 0) {
          return { errors: [{ text: `${manifest}: unsupported processes: ${JSON.stringify(program.unsupported)}` }] };
        }
        const fused = program.ir.processes.filter((p) => p.k === 'fused');
        return {
          contents: [
            "import * as rt from './umgeni/src/cpu/runtime.js';",
            `export const compileMs = ${compileMs.toFixed(1)};`,
            `export const nile = /* @__PURE__ */ rt.api(/* @__PURE__ */ (${program.source})(rt));`,
            ...fused.map((p) => `export const ${p.name}IR = ${JSON.stringify(p)};`),
          ].join('\n'),
          loader: 'js',
          resolveDir: fileURLToPath(root),
          watchFiles: programSources(manifest, root).map((p) => fileURLToPath(new URL(p, root))),
        };
      });
    },
  };
}
