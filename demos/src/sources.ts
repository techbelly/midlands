// Node-side: where the demos' Nile comes from — the .nl-lib files in
// demos/nl. Pages import a library and the bundler compiles it
// (tools/nile-plugin.ts); tests and tools compile the same file here.

import { readFileSync } from 'node:fs';
import { compileLibrary, type CompiledLibrary, type CompileOptions } from '../../umgeni/src/compile.js';

// The midlands root; overridable because bundling relocates import.meta.url.
export const ROOT = new URL('../../', import.meta.url);
export const read = (path: string, root: URL = ROOT) => readFileSync(new URL(path, root), 'utf8');

// A .nl-lib file names a Nile library's sources, one per line, relative to
// itself (`--` comments). Returned root-relative, ready for read().
export function librarySources(manifest: string, root: URL = ROOT): string[] {
  const base = new URL(manifest, root);
  return read(manifest, root)
    .split('\n')
    .map((line) => line.replace(/--.*/, '').trim())
    .filter(Boolean)
    .map((p) => new URL(p, base).href.slice(root.href.length));
}

// What `import { nile } from './nl/text.nl-lib'` gives a page, for node
// (with compile options): compileLibraryFile('demos/nl/text.nl-lib').api.
export function compileLibraryFile(manifest: string, opts: CompileOptions = {}, root: URL = ROOT): CompiledLibrary {
  return compileLibrary(librarySources(manifest, root).map((p) => read(p, root)), opts);
}
