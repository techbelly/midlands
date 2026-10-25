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
//   umgeni        the compiler, TypeScript and the Ohm grammar, by part;
//                 the CPU runtime is counted with the JS back end
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

const parts: [string, string[]][] = [
  ['gezira (Nile, unmodified)', files('gezira', /\.nl$/)],
  ['roda (Nile beyond gezira)', files('roda', /\.nl$/)],
  ["the demos' own Nile", files('demos/nl', /\.nl$/)],
  ['Nile in Mooi (semantics/*.mooi)', files('umgeni/src/semantics', /\.mooi$/)],
  ['mooi (the language)', files('mooi/src', /\.(ts|ohm)$/)],
  ['umgeni, all (TypeScript + Ohm)', files('umgeni/src', /\.(ts|ohm)$/, true)],
  ['  front end (grammar, parser, values, elaboration, substitution, IR, passes, Mooi hosts)',
    [...files('umgeni/src', /\.(ts|ohm)$/), ...files('umgeni/src/grammar', /\.ohm$/), ...files('umgeni/src/passes', /\.ts$/), ...files('umgeni/src/semantics', /\.ts$/)]],
  ['  JS back end and the CPU runtime', ['umgeni/src/cpu/js.ts', 'umgeni/src/cpu/runtime.ts']],
  ['  WebAssembly back end', ['umgeni/src/cpu/wasm.ts']],
  ['  GPU back end', files('umgeni/src/gpu', /\.ts$/)],
];

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
for (const [name, fs] of parts) console.log(`${pad(name, 88)} ${String(total(fs)).padStart(6)}`);

if (process.argv.includes('--files')) {
  console.log();
  for (const f of files('umgeni/src', /\.(ts|ohm|mooi)$/, true).sort()) console.log(`${pad(f, 48)} ${String(lines(f)).padStart(6)}`);
}
