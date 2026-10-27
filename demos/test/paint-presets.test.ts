// The paint page's presets, each compiled once with the page's library and
// glue: nothing unsupported, every pixel painted a finite colour, and the
// texture lowered to one WGSL paint() when its pipeline is map kernels, or
// refused with a reason when it filters. (GPU execution is checked headless
// by tools/check-paint-gpu.ts.)
import { describe, expect, it } from 'vitest';
import { librarySourceTexts } from '../src/sources.js';
import { compileLibrary } from '../../umgeni/src/compile.js';
import { lowerTexture } from '../../umgeni/src/gpu/texture.js';
import { PAINT_GLUE } from '../src/vector/paint.js';
import { PRESETS } from '../paint-presets.js';
import { square } from './fixtures.js';

const paintLibrary = librarySourceTexts('demos/nl/paint.nl-lib');

describe('paint presets', () => {
  for (const p of PRESETS) {
    it(p.name, () => {
      const library = compileLibrary([...paintLibrary, p.source, PAINT_GLUE]);
      expect(library.unsupported).toEqual([]);

      const pixels = library.api.PaintBeziers({ min: [0, 0], max: [480, 360] }).run(square(100, 120, 110, 126));
      expect(pixels.length).toBeGreaterThan(0);
      for (const t of pixels) for (const x of t) expect(Number.isFinite(x)).toBe(true);

      const tex = lowerTexture(library.ir, 'Paint');
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
