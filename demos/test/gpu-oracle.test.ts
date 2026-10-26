// The CPU against what a GPU last produced. CI has no GPU, so the Deno
// checks (npm run check:lowering, check:samples) record the GPU's answers
// in fixtures/gpu-oracle.json with npm run record:gpu, and this test holds
// the CPU to them with the checks' own tolerances. A change to the kernels
// or the lowering that moves the CPU's answer fails here; a change that
// moves the GPU's answer needs a real GPU, and a new recording.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORACLE_FILE, scenarios, unpack, type Oracle } from '../tools/gpu-scenarios.js';

const oracle = JSON.parse(readFileSync(ORACLE_FILE, 'utf8')) as Oracle;
const recordable = scenarios.filter((s) => s.cpu);

describe(`the CPU against the GPU's recorded answers (${ORACLE_FILE})`, () => {
  it('records every scenario that has a CPU side, and nothing else', () => {
    expect(Object.keys(oracle.results).sort()).toEqual(recordable.map((s) => s.what).sort());
  });

  for (const s of recordable) {
    it(s.what, () => {
      const recorded = oracle.results[s.what];
      expect(recorded, `${s.what}: not recorded; run npm run record:gpu on a machine with a GPU`).toBeDefined();
      expect(s.compare(s.what, s.cpu!(), unpack(recorded))).toMatch(/: ok, /);
    });
  }
});
