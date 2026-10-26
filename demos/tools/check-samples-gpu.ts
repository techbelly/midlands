// The samples' own Nile on a real GPU, against the CPU: the pipelines the
// Cairo samples page added that the lowering accepts by their declarations,
// none of which it was written against. The scenarios are in
// gpu-scenarios.ts, shared with the Node test that holds the CPU to the
// GPU's recorded answers.
//
// Run: npm run check:samples  (deno, with WebGPU); --record refreshes the
// recording, as npm run record:gpu does for every check.

import { runScenarios } from './gpu-oracle.js';
import { sampleScenarios } from './gpu-scenarios.js';

await runScenarios(sampleScenarios, 'samples');
