// Regenerate test/fixtures/paint-oracle.json: random coverage spans through
// the paint scenes (test/fixtures/paint-scenes.nl, mirrored in harness.c) —
// gradients, color spans, compositors and filters on the original runtime.
// Needs the oracle binary: `sh umgeni/tools/oracle/build.sh` first.
//   npx tsx umgeni/tools/oracle/gen-paint-fixtures.ts
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const harness = new URL('./build/harness', import.meta.url).pathname;
let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const scenes = ['SceneLinearPad', 'SceneRadialMultiply', 'SceneBlur', 'SceneFilters', 'SceneSoftLight'];

const cases = scenes.map((process) => {
  // Pixel-centred spans over a 100×80 area; some full coverage, some partial.
  const input = Array.from({ length: 30 }, () => [
    Math.floor(rnd() * 100) + 0.5, Math.floor(rnd() * 80) + 0.5,
    rnd() < 0.3 ? 1 : Math.round(rnd() * 64) / 64 + 1 / 64, 1 + Math.floor(rnd() * 12),
  ]);
  const stdout = execFileSync(harness, [process], { input: input.map((t) => t.join(' ')).join('\n') });
  const output = stdout.toString().trim().split('\n').filter(Boolean)
    .map((l) => l.split(' ').map((x) => +(+x).toPrecision(12)));
  return { process, params: [], input, output };
});
const out = new URL('../../test/fixtures/paint-oracle.json', import.meta.url);
writeFileSync(out, JSON.stringify({ source: 'gezira/c/gezira.c on nile/runtimes/c, float widened to double', cases }) + '\n');
console.log(`${cases.length} scenes, ${cases.reduce((n, c) => n + c.output.length, 0)} pixels -> ${out.pathname}`);
