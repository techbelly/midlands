// The GPU lowering is a compiler, not a template: pipelines it has never
// seen lower from their declarations and agree with the CPU. The scenarios
// are in gpu-scenarios.ts, shared with the Node test that holds the CPU to
// the GPU's recorded answers.
//
// Run: npm run check:lowering  (deno, with WebGPU); --record refreshes the
// recording, as npm run record:gpu does for every check.

import { runScenarios } from './gpu-oracle.js';
import { loweringScenarios } from './gpu-scenarios.js';

await runScenarios(loweringScenarios, 'lowering');
