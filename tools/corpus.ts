// The corpus's generated code, hashed: every demo library and gezira whole,
// as JavaScript and as JavaScript with WebAssembly inside. A refactor of
// the compiler that should change nothing leaves every hash the same; one
// that should change something shows which libraries moved. With --out
// <dir> the sources are written there too, for diffing two runs.
//
// Run: npm run corpus [-- --out <dir>]

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compileLibrary } from '../umgeni/src/compile.js';
import { compileLibraryFile } from '../demos/src/sources.js';

const ROOT = new URL('../', import.meta.url);
const at = (p: string) => new URL(p, ROOT);
const read = (p: string) => readFileSync(at(p), 'utf8');
const outAt = process.argv.indexOf('--out');
const out = outAt >= 0 ? process.argv[outAt + 1] : null;
if (out) mkdirSync(out, { recursive: true });

const libraries: [string, () => string][] = [];
for (const f of readdirSync(at('demos/nl/')).filter((f) => f.endsWith('.nl-lib')).sort()) {
  libraries.push([f, () => compileLibraryFile(`demos/nl/${f}`).source]);
  libraries.push([`${f} (wasm)`, () => compileLibraryFile(`demos/nl/${f}`, { target: 'wasm' }).source]);
}
const gezira = readdirSync(at('gezira/')).filter((f) => f.endsWith('.nl')).sort();
libraries.push(['gezira', () => compileLibrary(gezira.map((f) => read(`gezira/${f}`))).source]);

let all = createHash('sha256');
for (const [name, generate] of libraries) {
  const source = generate();
  all.update(source);
  if (out) writeFileSync(`${out}/${name.replace(/[^\w.-]+/g, '-')}.js`, source);
  console.log(createHash('sha256').update(source).digest('hex').slice(0, 16), String(source.length).padStart(8), name);
}
console.log(all.digest('hex').slice(0, 16), ''.padStart(8), 'all together');
