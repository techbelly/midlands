// Verifies zero-fence presentation headlessly (the tiger compositor with one
// black path): render text through the source-lowered pipeline into an
// offscreen texture, read the texture back (a fence, but only in this check;
// the browser path has none), and compare against the compute-only
// rasterizer's coverage.
//
// Run: npm run check:present  (deno, with WebGPU)

import { compileLibraryFile } from '../src/sources.js';
import { createCoverageReadback } from '../../umgeni/src/gpu/readback.js';
import { createPresenter } from '../../umgeni/src/gpu/present.js';
import { textBeziers, textSpansParams } from '../src/text/host.js';
import { coveragePlan, offscreenTexture, readTexture, requireDevice } from './gpu-check.js';

const library = compileLibraryFile('demos/nl/text.nl-lib');
const nile = library.api;

const W = 320;
const H = 48;
const params = textSpansParams({ size: 16, width: W, height: H, margin: 4 });
const front = (text: string, p = params) => new Float32Array(textBeziers(nile, text, p).flat());
const beziers = front('ZERO FENCES');
const n = beziers.length / 6;

const device = await requireDevice();
const plan = coveragePlan(library.ir, 'RasterizePixels', W, H);

// Reference: compute-only coverage (one fence).
const raster = createCoverageReadback(device, plan);
const cov = await raster.render(beziers, n);

// Presenter into an offscreen texture (no fence in frame()).
const tex = offscreenTexture(device, W, H);
// The compositor with one black path over white: pixel = 1 − coverage.
const presenter = createPresenter(device, plan, { format: 'rgba8unorm' });
const black = [0, 0, 0] as const;
const t0 = performance.now();
presenter.frame([{ tokens: beziers, n, color: black }], tex.createView());
const submitMs = performance.now() - t0;
const px = await readTexture(device, tex, W, H);

let maxErr = 0;
let dark = 0;
for (let i = 0; i < W * H; i++) {
  const v = px[i * 4]; // R channel
  const expected = Math.round(255 * (1 - Math.min(1, cov[i])));
  maxErr = Math.max(maxErr, Math.abs(v - expected));
  if (v < 128) dark++;
}
if (maxErr > 2) throw new Error(`presented pixels diverge from coverage: max channel error ${maxErr}`);
if (dark < 200) throw new Error(`too few dark pixels (${dark}) — did the text render?`);
console.log(
  `presenter ok: 'ZERO FENCES' at ${W}x${H}, ${n} beziers, ${dark} dark px, ` +
  `max channel err ${maxErr}, frame() submit ${submitMs.toFixed(2)} ms, fences in frame(): 0`,
);

// Pixels of the texture that are not white, in rows y0..H and columns x0..W.
const stalePixels = (px2: Uint8Array, y0: number, x0: number): number => {
  let stale = 0;
  for (let y = y0; y < H; y++) for (let x = x0; x < W; x++) if (px2[(y * W + x) * 4] < 250) stale++;
  return stale;
};

// Regression: a second, shorter frame must not ghost the first (the lowered
// resolve accumulates into coverage, so the core must clear it per frame).
{
  const beziers2 = front('ZERO');
  presenter.frame([{ tokens: beziers2, n: beziers2.length / 6, color: black }], tex.createView());
  // Pixels in the right half (where 'FENCES' was) must be back to white.
  const stale = stalePixels(await readTexture(device, tex, W, H), 0, Math.floor(W / 2));
  if (stale > 0) throw new Error(`ghosting: ${stale} stale pixels survived the second frame`);
  console.log(`no ghosting: second frame ('ZERO') left ${stale} stale pixels from frame one`);
}

// Regression: scaling DOWN must not ghost either. A smaller size draws fewer
// rows; each path clears and resolves only its own row band, so nothing may
// read (or draw) coverage outside that band — rows the previous, larger
// frame covered must come back white.
{
  const beziers3 = front('ZERO FENCES', textSpansParams({ size: 8, width: W, height: H, margin: 4 }));
  let maxY = 0;
  for (let i = 1; i < beziers3.length; i += 2) maxY = Math.max(maxY, beziers3[i]);
  presenter.frame([{ tokens: beziers3, n: beziers3.length / 6, color: black }], tex.createView());
  const below = Math.ceil(maxY) + 2;
  const stale = stalePixels(await readTexture(device, tex, W, H), below, 0);
  if (stale > 0) throw new Error(`ghosting after scaling down: ${stale} stale pixels below the text`);
  console.log(`no ghosting after scaling down: ${stale} stale pixels below row ${below}`);
}
