// The TrueType reader against the bundled Source Serif 4 (OFL, fonts/).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTrueType } from '../src/text/ttf.js';
import { compileLibraryFile } from '../src/sources.js';
import { renderText } from '../src/text/render.js';
import { colorRuns, fallback, paintCoverage } from '../src/text/host.js';

const font = parseTrueType(readFileSync(new URL('../fonts/SourceSerif4.ttf', import.meta.url)));

// Closed contours: each bezier ends where the next begins, except at contour
// ends; count the contour breaks.
const contours = (bs: number[][]) => bs.filter((b, i) => i === 0 || b[0] !== bs[i - 1][4] || b[1] !== bs[i - 1][5]).length;

describe('TrueType reader', () => {
  it('reads metrics', () => {
    expect(font.lineHeight).toBeGreaterThan(1);
    expect(font.lineHeight).toBeLessThan(2);
    expect(font.glyphFor('m').advance).toBeGreaterThan(font.glyphFor('i').advance); // proportional
  });

  it('converts outlines to closed quadratic contours', () => {
    // (Variable fonts keep overlapping contours — an 'l' is stem + serifs —
    // which nonzero winding fills correctly, so counts are not asserted.)
    for (const ch of 'OBlgé&') {
      const bs = font.glyphFor(ch).beziers;
      expect(bs.length).toBeGreaterThan(0);
      let start = 0;
      for (let i = 0; i < bs.length; i++) {
        expect(bs[i].every(Number.isFinite)).toBe(true);
        const last = i === bs.length - 1 || bs[i + 1][0] !== bs[i][4] || bs[i + 1][1] !== bs[i][5];
        if (last) {
          expect([bs[i][4], bs[i][5]]).toEqual([bs[start][0], bs[start][1]]); // closed
          start = i + 1;
        }
      }
    }
    expect(contours(font.glyphFor('O').beziers)).toBe(2); // outer + counter
  });

  it('handles composite glyphs, spaces, and unmapped characters', () => {
    expect(contours(font.glyphFor('é').beziers)).toBeGreaterThan(contours(font.glyphFor('e').beziers)); // e + accent
    expect(font.glyphFor(' ').beziers).toHaveLength(0);
    expect(font.glyphFor(' ').advance).toBeGreaterThan(0);
    expect(font.glyphFor('\u{10FFFD}').advance).toBeGreaterThanOrEqual(0); // .notdef
  });

  it('renders through the compiled text pipeline', () => {
    const W = 60;
    const H = 30;
    const library = compileLibraryFile('demos/nl/text.nl-lib');
    const { spans } = renderText(library, 'Oo', { size: 24, width: W, height: H, margin: 2, lineHeight: font.lineHeight, glyphs: font.glyphFor });
    const cov = paintCoverage(spans, W, H);
    // The capital O's counter is empty, its sides inked, along the mid row.
    const row = Array.from({ length: 22 }, (_, x) => cov[14 * W + 2 + x]);
    expect(Math.max(...row.slice(0, 5))).toBeGreaterThan(0.8);
    expect(Math.min(...row.slice(7, 12))).toBeLessThan(0.05);
  });
});

describe('colour emoji (COLR/CPAL, Twemoji)', () => {
  const emoji = parseTrueType(readFileSync(new URL('../fonts/Twemoji.Mozilla.ttf', import.meta.url)));

  it('reads colour layers: one colour per bezier, from the palette', () => {
    const tiger = emoji.glyphFor('🐯');
    expect(tiger.colors).toHaveLength(tiger.beziers.length);
    const colours = new Set(tiger.colors!.map((c) => JSON.stringify(c)));
    expect(colours.size).toBeGreaterThanOrEqual(4);
    for (const c of tiger.colors!) if (c) for (const x of c) expect(x).toBeGreaterThanOrEqual(0);
  });

  it('falls back per character, onto the primary font baseline', () => {
    const glyphs = fallback(font, emoji);
    expect(glyphs('a')).toBe(font.glyphFor('a')); // the text font has it
    const e = glyphs('😀');
    expect(e.colors).toBeDefined(); // from the emoji font
    const dy = font.ascent - emoji.ascent;
    expect(e.beziers[0][1]).toBeCloseTo(emoji.glyphFor('😀').beziers[0][1] + dy, 12);
  });

  it('lays out into colour runs, one per colour change, in painting order', () => {
    const library = compileLibraryFile('demos/nl/text.nl-lib');
    const glyphs = fallback(font, emoji);
    const runs = colorRuns(library.api, library.api.TextLayout({ w: 20, lh: font.lineHeight }), 'ab 😀 cd', glyphs);
    expect(runs[0].color).toBeNull(); // 'ab ' in the text colour
    expect(runs.at(-1)!.color).toBeNull(); // ' cd'
    expect(runs.slice(1, -1).every((r) => r.color !== null)).toBe(true); // the emoji's layers
    // Variation selectors and joiners are invisible, not .notdef boxes.
    expect(colorRuns(library.api, library.api.TextLayout({ w: 20, lh: 1 }), '❤️', glyphs).every((r) => r.color !== null)).toBe(true);
  });
});
