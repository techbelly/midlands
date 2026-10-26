import { describe, expect, it } from 'vitest';
import { compileLibraryFile } from '../src/sources.js';
import { renderText } from '../src/text/render.js';
import { asciiArt, paintCoverage, textTokens } from '../src/text/host.js';
import { run, streamer } from '../../umgeni/src/cpu/runtime.js';

const library = compileLibraryFile('demos/nl/text.nl-lib');

function coverage(text: string, size: number, width: number, height: number, margin = 2) {
  const { spans } = renderText(library, text, { size, width, height, margin });
  return paintCoverage(spans, width, height);
}

// Count runs of covered pixels in one row (e.g. the two stems of an H).
function runsInRow(buf: Float64Array, width: number, y: number, threshold = 0.5): number {
  let runs = 0;
  let inRun = false;
  for (let x = 0; x < width; x++) {
    const on = buf[y * width + x] > threshold;
    if (on && !inRun) runs++;
    inRun = on;
  }
  return runs;
}

describe('the text pipeline (roda/text.nl)', () => {
  it('compiles with nothing unsupported', () => {
    expect(library.unsupported).toEqual([]);
    expect(('TextSpans' in library.api)).toBe(true);
    expect(('TextLayout' in library.api)).toBe(true);
  });

  it('LayoutGlyphs advances the pen and wraps in Nile', () => {
    // Wrap width 3em, line height 1em; two glyphs of advance 2em: the second
    // would end at 4em > 3em, so it wraps to (0, 1).
    const s = streamer(library.api.LayoutGlyphs([3, 1]));
    const z = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    expect(s.push([...z, 2, 1, 0, 0])).toEqual([z]); // first glyph at the origin
    expect(s.push([...z, 2, 1, 0, 0])).toEqual([[0.1, 1.2, 0.3, 1.4, 0.5, 1.6]]);
    // A non-first token of the same glyph places at the same pen position.
    expect(s.push([...z, 2, 0, 0, 0])).toEqual([[0.1, 1.2, 0.3, 1.4, 0.5, 1.6]]);
  });

  // Unit-advance glyphs: (kind, x placed, y placed) per glyph, through the
  // whole TextLayout (Reverse → WordWidths → Reverse → LayoutGlyphs).
  const layout = (w: number, kinds: number[]) => {
    const z = [0, 0, 0, 0, 0, 0];
    const out = run(library.api.TextLayout([w, 1]), kinds.map((k) => [...z, 1, 1, k, 0]));
    return out.map((t) => [t[0], t[1]]);
  };

  it('wraps whole words (word widths computed in Nile, backwards)', () => {
    // "ab cd" at width 4: 'c' alone would fit at x=3, but the word "cd"
    // would not, so the whole word moves to the next line.
    expect(layout(4, [0, 0, 1, 0, 0])).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]);
    // At width 5 everything fits on one line.
    expect(layout(5, [0, 0, 1, 0, 0]).map((p) => p[1])).toEqual([0, 0, 0, 0, 0]);
  });

  it('breaks inside a word wider than the line, and at line breaks', () => {
    expect(layout(2, [0, 0, 0])).toEqual([[0, 0], [1, 0], [0, 1]]);
    expect(layout(9, [0, 2, 0])).toEqual([[0, 0], [0, 1], [0, 1]]);
  });

  it('lets a space hang past the margin rather than start a line', () => {
    // "ab cd" at width 2: the space after "ab" overflows but stays on line 0.
    expect(layout(2, [0, 0, 1, 0, 0])).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]);
  });

  it('renders an H: two stems and a crossbar', () => {
    const W = 20;
    const H = 16;
    const buf = coverage('H', 16, W, H);
    expect(runsInRow(buf, W, 4)).toBe(2); // upper cap: two stems
    expect(runsInRow(buf, W, 8)).toBe(1); // crossbar row: one solid run
    expect(runsInRow(buf, W, 11)).toBe(2); // lower: two stems again
  });

  it('renders an O with a counter (hole)', () => {
    const W = 20;
    const H = 16;
    const buf = coverage('O', 16, W, H);
    const mid = buf[8 * W + 6]; // glyph centre: x spans 2..10px, so 6 is mid

    expect(mid).toBeLessThan(0.15); // the hole
    expect(runsInRow(buf, W, 8)).toBe(2); // ring walls either side of it
  });

  it('a space advances the pen without marking pixels', () => {
    const W = 60;
    const H = 14;
    const spaced = coverage('I I', 12, W, H);
    const packed = coverage('II', 12, W, H);
    const rightmost = (buf: Float64Array) => {
      let max = -1;
      for (let i = 0; i < buf.length; i++) if (buf[i] > 0.5) max = Math.max(max, i % W);
      return max;
    };
    expect(rightmost(spaced)).toBeGreaterThan(rightmost(packed));
  });

  it('wraps to a new line when the measure is exceeded', () => {
    const W = 30;
    const H = 40;
    const { spans } = renderText(library, 'HHHH', { size: 12, width: W, height: H, margin: 2 });
    const ys = spans.filter((s) => Math.abs(s[2]) > 0.5).map((s) => s[1]);
    // Glyphs land on (at least) two distinct line bands.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(12);
  });

  it('space and unknown glyphs still produce well-formed tokens', () => {
    const tokens = textTokens(library.api, 'A ~');
    for (const t of tokens) expect(t).toHaveLength(10);
    // The space is a single degenerate bezier carrying its advance.
    const spaceToken = tokens.find((t) => t.slice(0, 6).every((v) => v === 0));
    expect(spaceToken).toBeDefined();
    expect(spaceToken![6]).toBeGreaterThan(0);
  });

  it('renders HELLO as expected (golden)', () => {
    const W = 76;
    const H = 14;
    expect(asciiArt(coverage('HELLO', 12, W, H), W, H)).toMatchSnapshot();
  });

  it('renders identically with kernel fusion (incl. the nested Rasterize splice)', () => {
    const fused = compileLibraryFile('demos/nl/text.nl-lib', { fuse: true });
    expect(fused.source).toContain('// run: LayoutGlyphs → TransformBeziers → ClipBeziers → DecomposeBeziers');
    const W = 76;
    const H = 14;
    const a = renderText(library, 'HELLO WRAP', { size: 12, width: W, height: H, margin: 2 });
    const b = renderText(fused, 'HELLO WRAP', { size: 12, width: W, height: H, margin: 2 });
    expect(b.spans).toEqual(a.spans);
  });
});
