// The sizes the READMEs quote, counted the same way every time: lines of
// source, blank lines and comments included (a comment is part of what a
// reader reads). Run: npm run sizes
//
// What is counted where:
//   gezira        Amelang's kernels, unmodified
//   roda          the library written beyond gezira
//   demos' Nile   the Nile particular to a page (demos/nl)
//   Nile in Mooi  the four files that define Nile (umgeni/src/semantics/*.mooi)
//   mooi          the language's implementation (grammar, evaluator, prelude)
//   umgeni        the compiler, by stage: Nile → AST (grammar, offside rule,
//                 operators, parser), AST → IR (the Mooi files and their
//                 hosts, the value algebra, substitution, the IR itself and
//                 the passes), and one back end each for IR → JS (with the
//                 CPU runtime), IR → wasm and IR → GPU
// Tests, tools, the demos' TypeScript and generated files are not counted.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const lines = (f: string) => readFileSync(join(root, f), 'utf8').split('\n').filter((_, i, a) => i < a.length - 1 || a[i] !== '').length;
const files = (dir: string, ext: RegExp, recurse = false): string[] =>
  readdirSync(join(root, dir)).flatMap((n) => {
    const f = join(dir, n);
    if (statSync(join(root, f)).isDirectory()) return recurse ? files(f, ext, true) : [];
    return ext.test(n) ? [f] : [];
  });
const total = (fs: string[]) => fs.reduce((n, f) => n + lines(f), 0);

const umgeniFront = ['umgeni/src/grammar/nile.ohm', 'umgeni/src/preprocess.ts', 'umgeni/src/ops.ts', 'umgeni/src/parser.ts', 'umgeni/src/ast.ts', 'umgeni/src/grammar/source.ts', 'umgeni/src/grammar/source.browser.ts'];
const umgeniMooi = files('umgeni/src/semantics', /\.mooi$/);
const umgeniMiddle = ['umgeni/src/compile.ts', 'umgeni/src/elaborate.ts', 'umgeni/src/values.ts', 'umgeni/src/substitute.ts', 'umgeni/src/ir.ts', 'umgeni/src/scalar.ts', 'umgeni/src/clike.ts', ...files('umgeni/src/semantics', /\.ts$/), ...files('umgeni/src/passes', /\.ts$/)];
const umgeniJs = files('umgeni/src/cpu', /\.ts$/).filter((f) => !f.endsWith('wasm.ts'));
const umgeniWasm = ['umgeni/src/cpu/wasm.ts'];
const umgeniGpu = files('umgeni/src/gpu', /\.ts$/);
const umgeniAll = [...umgeniFront, ...umgeniMooi, ...umgeniMiddle, ...umgeniJs, ...umgeniWasm, ...umgeniGpu];

const parts: [string, string[]][] = [
  ['gezira (Nile, unmodified)', files('gezira', /\.nl$/)],
  ['roda (Nile beyond gezira)', files('roda', /\.nl$/)],
  ["the demos' own Nile", files('demos/nl', /\.nl$/)],
  ['mooi (the language)', files('mooi/src', /\.(ts|ohm)$/)],
  ['umgeni, all (TypeScript, Ohm, Mooi)', umgeniAll],
  ['  Nile → AST: grammar, offside rule, operators, parser', umgeniFront],
  ['  AST → IR: Nile in Mooi (values, kernels, sugar, pipelines)', umgeniMooi],
  ['  AST → IR: the Mooi hosts, the value algebra, substitution, the IR, the passes', umgeniMiddle],
  ['  IR → JS, and the CPU runtime', umgeniJs],
  ['  IR → WebAssembly', umgeniWasm],
  ['  IR → GPU (WGSL, lowering, execution, presentation)', umgeniGpu],
];

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
for (const [name, fs] of parts) console.log(`${pad(name, 88)} ${String(total(fs)).padStart(6)}`);

const everything = files('umgeni/src', /\.(ts|ohm|mooi)$/, true);
for (const f of everything) if (!umgeniAll.includes(f)) console.log(`not counted in any stage: ${f}`);
for (const f of umgeniAll) if (umgeniAll.indexOf(f) !== umgeniAll.lastIndexOf(f)) console.log(`counted twice: ${f}`);

if (process.argv.includes('--files')) {
  console.log();
  for (const f of files('umgeni/src', /\.(ts|ohm|mooi)$/, true).sort()) console.log(`${pad(f, 48)} ${String(lines(f)).padStart(6)}`);
}
