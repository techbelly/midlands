// What the demo bundles import as data (demos/tools/build.mjs loaders):
// Nile source and SVG as text, fonts as bytes.
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
