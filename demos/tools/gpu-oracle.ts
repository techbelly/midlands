// Runs GPU scenarios on a real device against the CPU, and with --record
// writes the GPU's answers to demos/test/fixtures/gpu-oracle.json for the
// Node test to hold the CPU to. Deno with WebGPU only.

import { requireDevice } from './gpu-check.js';
import { ORACLE_FILE, pack, type Oracle, type Scenario } from './gpu-scenarios.js';

async function readOracle(): Promise<Oracle> {
  try {
    return JSON.parse(await Deno.readTextFile(ORACLE_FILE)) as Oracle;
  } catch {
    return { recorded: { on: '', by: '' }, results: {} };
  }
}

export async function runScenarios(scenarios: Scenario[], label: string): Promise<void> {
  const record = Deno.args.includes('--record');
  const device = await requireDevice();
  const oracle = record ? await readOracle() : null;
  for (const s of scenarios) {
    const expected = s.cpu ? s.cpu() : await s.reference!(device);
    const got = await s.gpu(device);
    console.log(s.compare(s.what, expected, got));
    if (oracle && s.cpu) oracle.results[s.what] = pack(got);
  }
  if (oracle) {
    oracle.recorded = { on: new Date().toISOString().slice(0, 10), by: `deno ${Deno.version.deno}, ${Deno.build.os} ${Deno.build.arch}` };
    await Deno.writeTextFile(ORACLE_FILE, JSON.stringify(oracle) + '\n');
    console.log(`recorded ${scenarios.filter((s) => s.cpu).length} GPU answers in ${ORACLE_FILE}`);
  }
  console.log(`${label} ok`);
}
