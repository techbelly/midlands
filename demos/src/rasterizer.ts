// The rasterizer, as an option on a page (the `exact` checkbox).
//
// Off, a page rasterizes as it always has, by gezira's DecomposeBeziers:
// a curve halved until a midpoint is within a tenth of a pixel of the grid
// and then moved onto it. On, by roda/rasterize-exact.nl: a curve cut where
// it meets the grid, each piece giving the area under the curve itself. The
// stages after the edge samples are the same either way, and so is every
// back end: the pipelines differ only in their first stages.
//
// A page asks which pipeline to run (`spans` on the CPU, `pixels` for the
// GPU's lowering) and which definitions to quote, and draws again when
// `onChange` fires.
export class Rasterizer {
  private readonly box: HTMLInputElement | null;

  constructor(onChange: () => void) {
    this.box = document.getElementById('exact') as HTMLInputElement | null;
    this.box?.addEventListener('change', onChange);
  }

  get exact(): boolean {
    return this.box?.checked ?? false;
  }

  /** The pipeline giving coverage spans: the exact one, or the page's own. */
  spans<Usual extends string>(usual: Usual): Usual | 'RasterizeExact' {
    return this.exact ? 'RasterizeExact' : usual;
  }

  /** The pipeline giving pixels, which the GPU lowers. */
  get pixels(): 'RasterizePixels' | 'RasterizePixelsExact' {
    return this.exact ? 'RasterizePixelsExact' : 'RasterizePixels';
  }

  /** The names a page quotes, its usual rasterizer's replaced by the exact
   *  one's when that is what runs. */
  quoted(names: string[]): string[] {
    if (!this.exact) return names;
    const usual = new Set(['Rasterize', 'RasterizeParallel', 'RasterizePixels']);
    const at = names.findIndex((n) => usual.has(n));
    const rest = names.filter((n) => !usual.has(n));
    if (at < 0) return names;
    return [...rest.slice(0, at), 'MonotoneBeziers', 'DecomposeExact', 'RasterizeExact', ...(names.includes('RasterizePixels') ? ['RasterizePixelsExact'] : []), ...rest.slice(at)];
  }

  /** For a timing line: which rasterizer drew. */
  get label(): string {
    return this.exact ? 'exact rasterizer' : "gezira's rasterizer";
  }
}
