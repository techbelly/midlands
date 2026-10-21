// Coverage spans → pixels: the host's one rendering job on the CPU path.
// A span is flat [x, y, coverage, length].

export type RGB = readonly [number, number, number];

export function hexRGB(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as RGB;
}

export interface ImgLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

// Composite CoverageSpans (flat [x, y, c, l]) over the image in `color`.
// Span coordinates are pixel centres (n + 0.5), so they FLOOR to pixel n —
// the same convention as paintCoverage and the GPU grid. (chari's original
// rounded, shifting its whole image by one pixel, self-consistently.)
export function paintSpans(img: ImgLike, spans: number[][], color: RGB): void {
  const { width, height, data } = img;
  for (const [x, y, c, l] of spans) {
    const cov = Math.min(1, Math.abs(c));
    if (cov <= 0) continue;
    const yi = Math.floor(y);
    if (yi < 0 || yi >= height) continue;
    const len = Math.max(1, Math.round(l));
    const x0 = Math.floor(x);
    for (let i = 0; i < len; i++) {
      const xi = x0 + i;
      if (xi < 0 || xi >= width) continue;
      const idx = (yi * width + xi) * 4;
      data[idx] = color[0] * cov + (data[idx] as number) * (1 - cov);
      data[idx + 1] = color[1] * cov + (data[idx + 1] as number) * (1 - cov);
      data[idx + 2] = color[2] * cov + (data[idx + 2] as number) * (1 - cov);
      data[idx + 3] = 255;
    }
  }
}
