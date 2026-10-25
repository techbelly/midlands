// What the demo bundles import as data (demos/tools/build.mjs loaders):
// Nile source and SVG as text, fonts as bytes, and Nile libraries compiled
// (demos/tools/nile-plugin.ts).
declare module '*.nl-lib' {
  import type { Api } from '../../umgeni/src/cpu/runtime.js';
  import type { FusedIR } from '../../umgeni/src/ir.js';
  export const nile: Api;
  export const nileWasm: Api; // the same library, its pipelines compiled to WebAssembly
  export const compileMs: number;
  // One <Name>IR per fused process; only those the pages lower are declared.
  export const RasterizePixelsIR: FusedIR;
}
declare module '*.nl' {
  const source: string;
  export default source;
}
declare module '*.svg' {
  const source: string;
  export default source;
}
declare module '*.ttf' {
  const bytes: Uint8Array;
  export default bytes;
}
