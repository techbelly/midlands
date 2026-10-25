// Textures lower to one WGSL paint() function when their pipeline is made of
// map kernels; filters are refused with a reason. (GPU execution is checked
// headless by tools/check-paint-gpu.ts.)
import { read } from '../src/sources.js';
import { describe, expect, it } from 'vitest';
import { compileLibrary } from '../../umgeni/src/compile.js';
import { lowerTexture } from '../../umgeni/src/gpu/texture.js';
import { PRESETS } from '../paint-presets.js';

const library = ['types', 'texture', 'compositor', 'gradient', 'filter'].map((n) => read(`gezira/${n}.nl`));

describe('texture lowering', () => {
  for (const p of PRESETS) {
    it(p.name, () => {
      const tex = lowerTexture(compileLibrary([...library, p.source]).ir, 'Paint');
      if (/blur|bicubic/i.test(p.name)) {
        expect(tex.ok).toBe(false);
        if (!tex.ok) expect(tex.reason).toMatch(/not a map kernel/);
      } else {
        expect(tex.ok).toBe(true);
        if (tex.ok) {
          expect(tex.wgsl).toMatch(/^fn paint\(px : f32, py : f32\) -> vec4f \{$/m);
          expect(tex.wgsl).toMatch(/return vec4f\(/);
        }
      }
    });
  }
});
