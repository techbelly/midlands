// Device resolution, as an option on each page (the `hires` checkbox).
//
// A canvas keeps the size the page declared as its CSS size, so the layout
// never moves. Its backing store, the picture Nile draws, is that size when
// the option is off (the default: 880 × 360 pixels on any screen, which a
// dense screen shows upscaled) and that size times devicePixelRatio when it
// is on, one picture pixel per device pixel. A page multiplies its geometry
// by `scale`, so the picture is the same picture, sharper, and rebuilds what
// it built for a size when `onChange` fires.
export class Resolution {
  private readonly box: HTMLInputElement | null;
  private ratio = window.devicePixelRatio || 1;

  constructor(onChange: () => void) {
    this.box = document.getElementById('hires') as HTMLInputElement | null;
    if (this.box) {
      this.box.addEventListener('change', onChange);
      if (this.ratio === 1) {
        this.box.disabled = true;
        this.box.title = 'This screen has one device pixel per CSS pixel already.';
      }
    }
    // A window dragged to another screen changes the ratio.
    window.addEventListener('resize', () => {
      const now = window.devicePixelRatio || 1;
      if (now === this.ratio) return;
      this.ratio = now;
      if (this.box?.checked) onChange();
    });
  }

  /** Picture pixels per CSS pixel: the ratio when the option is on, else 1. */
  get scale(): number {
    return this.box?.checked ? this.ratio : 1;
  }

  // The size each canvas had when first fitted: the size the page declared.
  private readonly declared = new WeakMap<HTMLCanvasElement, { w: number; h: number }>();

  /** The canvas at its declared size in CSS pixels, its store scaled. The
   *  store is set only when it changes, since setting a canvas's size
   *  clears it. */
  fit(canvas: HTMLCanvasElement): void {
    let d = this.declared.get(canvas);
    if (!d) this.declared.set(canvas, (d = { w: canvas.width, h: canvas.height }));
    const { w, h } = d;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const pw = Math.round(w * this.scale);
    const ph = Math.round(h * this.scale);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
  }

  /** The picture's size for a stats line: `880 × 360 px`, or at scale
   *  `1760 × 720 px (2× device pixels)`. */
  label(w: number, h: number): string {
    const k = this.scale;
    return `${w} × ${h} px${k === 1 ? '' : ` (${Number(k.toFixed(2))}× device pixels)`}`;
  }
}
