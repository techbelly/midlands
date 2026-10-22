// Node-side: where the demos' Nile comes from — the .program files in
// demos/nl. Pages import a program and the bundler compiles it
// (tools/nile-plugin.ts); tests and tools compile the same file here.

import { readFileSync } from 'node:fs';
import { compileProgram, type CompiledProgram, type CompileOptions } from '../../umgeni/src/compile.js';

// The midlands root; overridable because bundling relocates import.meta.url.
export const ROOT = new URL('../../', import.meta.url);
export const read = (path: string, root: URL = ROOT) => readFileSync(new URL(path, root), 'utf8');

// A .program file names a Nile program's sources, one per line, relative to
// itself (`--` comments). Returned root-relative, ready for read().
export function programSources(manifest: string, root: URL = ROOT): string[] {
  const base = new URL(manifest, root);
  return read(manifest, root)
    .split('\n')
    .map((line) => line.replace(/--.*/, '').trim())
    .filter(Boolean)
    .map((p) => new URL(p, base).href.slice(root.href.length));
}

// What `import { nile } from './nl/text.program'` gives a page, for node
// (with compile options): compileProgramFile('demos/nl/text.program').api.
export function compileProgramFile(manifest: string, opts: CompileOptions = {}, root: URL = ROOT): CompiledProgram {
  return compileProgram(programSources(manifest, root).map((p) => read(p, root)), opts);
}
