// Regenerate test/fixtures/stroke-oracle.json: random curved paths (open and
// closed) through the original gezira stroke processes, every cap and join.
// Needs the oracle binary: `sh umgeni/tools/oracle/build.sh` first.
//   npx tsx umgeni/tools/oracle/gen-stroke-fixtures.ts
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const harness = new URL('./build/harness', import.meta.url).pathname;
const q = (x: number) => Math.round(x * 16) / 16; // exactly representable inputs
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

function path(n: number, closed: boolean): number[][] {
  const pts = Array.from({ length: n + 1 }, () => [q(rnd() * 200), q(rnd() * 200)]);
  if (closed) pts[n] = pts[0];
  return pts.slice(0, n).map((a, i) => {
    const c = pts[i + 1];
    return [...a, q((a[0] + c[0]) / 2 + (rnd() - 0.5) * 120), q((a[1] + c[1]) / 2 + (rnd() - 0.5) * 120), ...c];
  });
}

const cases = [];
for (let k = 0; k < 27; k++) {
  const input = path(1 + (k % 5), k % 2 === 0);
  const w = q(2 + rnd() * 20);
  const join = [-1, 4, 1.5][k % 3]; // round, miter, miter with a tight limit
  const cap = [-1, 0, 1][Math.floor(k / 3) % 3]; // round, butt, square
  for (const [process, params] of [
    ['StrokeOneSide', [w, join, cap]],
    ['OffsetBezier', [w / 2, ...input[0]]],
    ['StrokeBezierPath', [w, join, cap]],
  ] as [string, number[]][]) {
    const stdout = execFileSync(harness, [process, ...params.map(String)], { input: input.map((b) => b.join(' ')).join('\n') });
    const output = stdout.toString().trim().split("\n").filter(Boolean).map((l) => l.split(" ").map((x) => +(+x).toPrecision(12)));
    cases.push({ process, params, input, output });
  }
}
const out = new URL('../../test/fixtures/stroke-oracle.json', import.meta.url);
writeFileSync(out, JSON.stringify({ source: 'gezira/c/gezira.c on nile/runtimes/c, float widened to double', cases }) + '\n');
console.log(`${cases.length} cases -> ${out.pathname}`);
