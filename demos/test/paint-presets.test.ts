// The paint page's presets compile (with the page's library + glue) and
// paint every pixel of a span with a finite colour.
import { read } from '../src/sources.js';
import { describe, expect, it } from 'vitest';
import { compileLibrary, makeStreamer } from '../../umgeni/src/compile.js';
import { PRESETS } from '../paint-presets.js';

const gezira = ['types', 'bezier', 'stroke', 'rasterize', 'texture', 'compositor', 'gradient', 'filter']
  .map((n) => read(`gezira/${n}.nl`));
const glue = 'Painted : CoverageSpan >> (Color, CoveragePoint)\n    ⇒ ApplyTexture (Paint)\n';

describe('paint presets', () => {
  for (const p of PRESETS) {
    it(p.name, () => {
      const library = compileLibrary([...gezira, read('demos/nl/vector.nl'), p.source, glue]);
      expect(library.unsupported).toEqual([]);
      const s = makeStreamer(library, 'Painted');
      const out = [...s.push([100.5, 120.5, 1, 6]), ...s.end()];
      expect(out).toHaveLength(6);
      for (const t of out) for (const x of t) expect(Number.isFinite(x)).toBe(true);
    });
  }
});
