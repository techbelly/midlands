// The hinting page's host code, headless: text set down off the pixel grid
// finds it, by the derivative Nile gives of its own rasterizer
// (src/hinting/hint.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileLibraryFile, ROOT } from '../src/sources.js';
import { createHint, directionsFor, grey, ink, setLines, type Line } from '../src/hinting/hint.js';
import { parseTrueType } from '../src/text/ttf.js';

const DIRECTIONS = 24;
const moving = compileLibraryFile('demos/nl/hinting.nl-lib', { directions: DIRECTIONS, target: 'wasm' });
const plain = compileLibraryFile('demos/nl/hinting.nl-lib', { target: 'wasm' });
const font = parseTrueType(new Uint8Array(readFileSync(new URL('demos/fonts/SourceSerif4.ttf', ROOT))));

const SENTENCE = 'Small text set down anywhere is grey. A stem a pixel and a third wide lands across two columns.';
const word = (at: number[]): Line => setLines(font, 'hinting', 13, at, 380)[0];
const settle = (line: Line, keep: number, even: number) => {
  const hint = createHint(moving, DIRECTIONS, line, { keep, even });
  while (!hint.settled) hint.advance();
  return hint;
};
// A line as the plain rasterizer draws it, all its letters at once.
const whole = (line: Line, beziers = line.letters.flat()): Float64Array => {
  const c = new Float64Array(line.width * line.height);
  for (const s of plain.api.RasterizeExact().run(beziers)) {
    for (let i = 0; i < s[3]; i++) c[Math.floor(s[1]) * line.width + Math.floor(s[0]) + i] = s[2];
  }
  return c;
};

describe('text finds the pixel grid, by the derivative of the rasterizer', () => {
  it('has a derivative for the rasterizer the page runs', () => {
    expect(moving.unsupported.map((u) => u.name)).not.toContain('RasterizeExact');
  });

  // Lines break at spaces within the measure, each a line height below the
  // last: so each its own fraction of a pixel down its rows.
  it('sets text as lines within the measure', () => {
    const lines = setLines(font, SENTENCE, 13, [0.37, 0.41], 380);
    expect(lines.map((l) => l.shown).join(' ')).toBe(SENTENCE);
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line.width).toBeLessThanOrEqual(380);
    expect(lines[1].row).toBe(Math.floor(1.41 + font.lineHeight * 13) - 1);
    const down = (line: Line) => line.row + Math.min(...line.letters.flat().map((b) => b[1]));
    expect(down(lines[1]) - down(lines[0])).toBeCloseTo(font.lineHeight * 13, 9);
    expect(setLines(font, '   ', 13, [0, 0], 380)).toEqual([]);
  });

  // A line has hundreds of knots; no letter of it lies among more than the
  // library has directions for.
  it('asks a direction only for each knot a letter lies among', () => {
    const lines = setLines(font, SENTENCE, 13, [0.37, 0.41], 380);
    expect(lines[0].width + lines[0].height + 2).toBeGreaterThan(300);
    expect(directionsFor(lines)).toBeLessThanOrEqual(DIRECTIONS);
    expect(() => createHint(moving, DIRECTIONS, setLines(font, 'W', 40, [0, 0], 380)[0], { keep: 4, even: 2 })).toThrow(/knots/);
  });

  // The letters are rasterized one at a time and their pictures added: that
  // is the picture of the line rasterized whole, before the knots have slid
  // and after.
  it('adds the letters\' pictures to the line\'s own', () => {
    for (const line of setLines(font, SENTENCE, 13, [0.37, 0.41], 380)) {
      const hint = createHint(moving, DIRECTIONS, line, { keep: 4, even: 2 });
      expect(hint.beziers()).toEqual(line.letters.flat());
      const differs = (a: Float64Array, b: Float64Array) => a.reduce((most, v, i) => Math.max(most, Math.abs(v - b[i])), 0);
      expect(differs(hint.before, whole(line))).toBeLessThan(1e-12);
      for (let i = 0; i < 40; i++) hint.advance();
      expect(Math.max(...hint.slide.map(Math.abs))).toBeGreaterThan(0.1);
      expect(differs(hint.coverage, whole(line, hint.beziers()))).toBeLessThan(1e-12);
    }
  });

  // What the knots follow is the slope of what is wanted: for the knots it
  // matters most to, a small slide either way changes it by what the
  // gradient says. (A few steps in, so that the knots are somewhere and no
  // edge is on a pixel line, where the grey has a corner.)
  it('follows the slope of what it wants', () => {
    const hint = createHint(moving, DIRECTIONS, setLines(font, SENTENCE, 13, [0.37, 0.41], 380)[0], { keep: 4, even: 2 });
    for (let i = 0; i < 5; i++) hint.advance();
    const said = Array.from(hint.gradient);
    const most = said.map((g, j) => [Math.abs(g), j]).sort((a, b) => b[0] - a[0]).slice(0, 8).map(([, j]) => j);
    expect(Math.abs(said[most[0]])).toBeGreaterThan(1);
    expect(most.some((j) => j >= hint.across), 'a knot down among them').toBe(true);
    const h = 1e-6;
    for (const j of most) {
      const was = hint.slide[j];
      hint.slideTo(j, was + h);
      const up = hint.wanted;
      hint.slideTo(j, was - h);
      const down = hint.wanted;
      hint.slideTo(j, was);
      expect((up - down) / (2 * h), `knot ${j}`).toBeCloseTo(said[j], 4);
    }
  });

  // Wherever within a pixel a word is set down, the grey falls by three
  // tenths or more, the word keeps nine tenths of its ink, and no knot
  // slides as far as a pixel.
  it('is sharper wherever it was set down, and still the word', () => {
    for (const at of [[0.37, 0.41], [0.5, 0.5], [0.05, 0.93], [0.71, 0.18]]) {
      const hint = settle(word(at), 4, 2);
      expect(hint.grey, `grey from ${at}`).toBeLessThan(0.7 * grey(hint.before));
      expect(ink(hint.coverage), `ink from ${at}`).toBeGreaterThan(0.88 * ink(hint.before));
      expect(Math.max(...hint.slide.map(Math.abs)), `slide from ${at}`).toBeLessThan(1);
    }
  });

  // A whole line is held as a word is: it is as much sharper, and its knots
  // go no further, however many letters pull on the knots down.
  it('holds a long line as it holds a word', () => {
    for (const line of setLines(font, SENTENCE, 13, [0.37, 0.41], 380)) {
      const hint = settle(line, 4, 2);
      expect(hint.grey, line.shown).toBeLessThan(0.75 * grey(hint.before));
      expect(ink(hint.coverage), line.shown).toBeGreaterThan(0.88 * ink(hint.before));
      expect(Math.max(...hint.slide.map(Math.abs)), line.shown).toBeLessThan(0.8);
    }
  });

  // With nothing to hold it the word is sharper still and no longer the
  // word: blurred, it is several times as far from what it was.
  it('closes up into slabs when nothing holds it', () => {
    const held = settle(word([0.37, 0.41]), 4, 2);
    const loose = settle(word([0.37, 0.41]), 0, 0);
    expect(loose.grey).toBeLessThan(0.6 * held.grey);
    expect(loose.away).toBeGreaterThan(3 * held.away);
  });
});
