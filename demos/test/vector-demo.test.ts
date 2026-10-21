// The tiger/strokes demo host code, validated headless: gezira's own kernels
// (stroke.nl unmodified) + nl/vector.nl compiled by Umgeni, driven with flat
// cubics from the SVG parser, composited by paintSpans.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { read } from '../src/sources.js';
import { compileVectorPipeline } from '../src/vector/compile.js';
import { collectSpans, strokeOutline } from '../src/vector/draw.js';
import { parseSvg, pathCubics, pathSubpaths } from '../src/vector/svg.js';
import { drawTiger, fitView } from '../src/vector/tiger.js';


const program = compileVectorPipeline();
const tiger = parseSvg(read('demos/tiger.svg'), program.registry);

describe('the tiger demo, headless', () => {
  it('compiles the gezira kernels with nothing unsupported', () => {
    expect(program.unsupported).toEqual([]);
    for (const name of ['FillPath', 'StrokeOutline', 'FillBeziers']) {
      expect(program.registry.has(name), name).toBe(true);
    }
  });

  it('parses the SVG into paths of cubics', () => {
    expect(tiger.paths.length).toBe(240);
    const segs = tiger.paths.reduce((a, p) => a + p.cubics.length, 0);
    expect(segs).toBeGreaterThan(2000);
    for (const p of tiger.paths.slice(0, 5)) {
      for (const c of p.cubics) expect(c).toHaveLength(8);
    }
  });

  it('renders the whole tiger through the compiled pipelines', () => {
    const W = 128;
    const H = 128;
    const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) };
    const t0 = performance.now();
    const paths = drawTiger(img, tiger, fitView(W, H), program.registry);
    const ms = performance.now() - t0;
    expect(paths).toBe(240);
    let colored = 0;
    for (let i = 0; i < W * H; i++) {
      const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
      if (r !== 255 || g !== 255 || b !== 255) colored++;
    }
    // The tiger fills most of the frame.
    expect(colored).toBeGreaterThan(W * H * 0.3);
    // eslint-disable-next-line no-console
    console.log(`tiger ${W}x${H}: ${colored} colored px in ${ms.toFixed(0)} ms`);
  });

  // Every pixel, pinned: a refactor of any stage (SVG parsing included) must
  // reproduce the tiger exactly.
  it('renders the same tiger, pixel for pixel', () => {
    const img = { width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(255) };
    drawTiger(img, tiger, fitView(200, 200), program.registry);
    expect(createHash('sha256').update(img.data).digest('hex')).toMatchSnapshot();
  });

  it('strokes subpaths as SVG draws them: closed only by Z', () => {
    const subpaths = (d: string) => pathSubpaths(program.registry, d);
    expect(subpaths('M0 0 L10 0 L10 10').map((p) => p.length)).toEqual([2]);
    expect(subpaths('M0 0 L10 0 L10 10 Z').map((p) => p.length)).toEqual([3]);
    expect(subpaths('M0 0 L10 0 M20 0 L30 0').map((p) => p.length)).toEqual([1, 1]);
  });

  it('interprets path commands as SVG does (in Nile: nl/svg.nl)', () => {
    const ends = (d: string) => pathCubics(program.registry, d).map((c) => c.slice(6));
    // relative coordinates, H and V, implicit repeats (after m they are l)
    expect(ends('m1 1 2 0 h3 v4 H0 V1')).toEqual([[3, 1], [6, 1], [6, 5], [0, 5], [0, 1], [1, 1]]);
    // a relative m is measured from the current point, or after z from the subpath's start
    expect(ends('M0 0 l10 0 m5 5 l1 0')).toEqual([[10, 0], [0, 0], [16, 5], [15, 5]]);
    expect(ends('M2 2 l10 0 z m5 5 l1 0')).toEqual([[12, 2], [2, 2], [8, 7], [7, 7]]);
    // S reflects the previous control point, and only after C or S
    const [, s] = pathCubics(program.registry, 'M0 0 C1 0 2 1 3 3 S5 6 6 6');
    expect(s.slice(0, 4)).toEqual([3, 3, 4, 5]);
    expect(pathCubics(program.registry, 'M0 0 L3 3 S5 6 6 6')[1].slice(0, 4)).toEqual([3, 3, 3, 3]);
  });

  it('strokes a path with caps and joins (the strokes demo pipeline)', () => {
    const I = [1, 0, 0, 1, 0, 0];
    const zig = [
      [20, 90, 40, 60, 60, 40, 80, 20],
      [80, 20, 100, 40, 120, 60, 140, 90],
    ];
    const outline = (join: number, cap: number) => strokeOutline(program.registry, I, 12, join, cap, [zig]);
    // Round joins/caps subdivide into more pieces than miter + butt.
    expect(outline(-1, -1).length).toBeGreaterThan(outline(4, 0).length);
    const spans = collectSpans(program.registry.get('FillBeziers')!([0, 0, 200, 120]), outline(-1, -1));
    expect(spans.length).toBeGreaterThan(50);
    // Coverage lands inside the canvas.
    for (const [x, y] of spans.slice(0, 20)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });
});
