// The corpus: every demo library and gezira whole, as JavaScript, as
// JavaScript with WebAssembly inside, and as the WGSL of every pipeline and
// texture the GPU lowering takes (with the refusals it gives the rest).
// npm run corpus prints their hashes; tools/corpus.test.ts holds them to the
// ones recorded in tools/corpus.json.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { compileLibrary, type CompiledLibrary } from '../umgeni/src/compile.js';
import { compileLibraryFile } from '../demos/src/sources.js';
import { lowerPipeline, LowerError } from '../umgeni/src/gpu/lower.js';
import { appendSink, coverageSink } from '../umgeni/src/gpu/execute.js';
import { lowerTexture } from '../umgeni/src/gpu/texture.js';

const ROOT = new URL('../', import.meta.url);
const at = (p: string) => new URL(p, ROOT);
const read = (p: string) => readFileSync(at(p), 'utf8');

export const RECORD = at('tools/corpus.json');
export const hashOf = (source: string) => createHash('sha256').update(source).digest('hex').slice(0, 16);
export const recorded = (): Record<string, string> => JSON.parse(readFileSync(RECORD, 'utf8')) as Record<string, string>;

// Each entry generates its source only when asked, so a caller can time or
// test one library at a time.
export function corpus(): [string, () => string][] {
  const libraries: [string, () => string][] = [];
  for (const f of readdirSync(at('demos/nl/')).filter((f) => f.endsWith('.nl-lib')).sort()) {
    libraries.push([f, () => compileLibraryFile(`demos/nl/${f}`).source]);
    libraries.push([`${f} (wasm)`, () => compileLibraryFile(`demos/nl/${f}`, { target: 'wasm' }).source]);
    libraries.push([`${f} (wgsl)`, () => wgslOf(compileLibraryFile(`demos/nl/${f}`))]);
  }
  // types.nl defines the operators the other files use, so it comes first.
  const gezira = ['types.nl', ...readdirSync(at('gezira/')).filter((f) => f.endsWith('.nl') && f !== 'types.nl').sort()];
  libraries.push(['gezira', () => compileLibrary(gezira.map((f) => read(`gezira/${f}`))).source]);
  return libraries;
}

// Every WGSL a library can give the GPU: each fused pipeline lowered to a
// coverage image and to appended tokens (or the reason it is refused), and
// each process as a texture (or why it is not one).
function wgslOf(lib: CompiledLibrary): string {
  const out: string[] = [];
  for (const p of lib.ir.processes) {
    if (p.k === 'fused') {
      const sinks = { coverage: { extent: [64, 64], sink: coverageSink }, appended: { extent: [8], sink: appendSink(p.runs.length) } };
      for (const [how, opts] of Object.entries(sinks)) {
        try {
          for (const pass of lowerPipeline(p, opts).passes) out.push(`// ${p.name}, ${how}: ${pass.name}\n${pass.wgsl}// bindings ${JSON.stringify(pass.bindings)}\n`);
        } catch (e) {
          if (!(e instanceof LowerError)) throw e;
          out.push(`// ${p.name}, ${how}: refused, ${e.message}\n`);
        }
      }
    }
    const t = lowerTexture(lib.ir, p.name);
    out.push(t.ok ? `// ${p.name} as a texture\n${t.wgsl}\n` : `// ${p.name} is not a texture: ${t.reason}\n`);
  }
  return out.join('\n');
}
