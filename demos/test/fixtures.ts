// What the demo tests share: the bundled fonts, parsed once, and a square
// as flat beziers.
import { readFileSync } from 'node:fs';
import { parseTrueType, type Font } from '../src/text/ttf.js';

const fonts = new Map<string, Font>();
const font = (file: string): Font => {
  let f = fonts.get(file);
  if (!f) fonts.set(file, (f = parseTrueType(readFileSync(new URL(`../fonts/${file}`, import.meta.url)))));
  return f;
};
// Source Serif 4: SIL OFL 1.1 (fonts/OFL.txt).
export const sourceSerif = (): Font => font('SourceSerif4.ttf');
// Twemoji, Mozilla's build: colour emoji (COLR/CPAL).
export const twemoji = (): Font => font('Twemoji.Mozilla.ttf');

// A square as flat beziers, clockwise or anticlockwise.
export const square = (x0: number, y0: number, x1: number, y1: number, cw = true): number[][] => {
  const pts = cw ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
  return pts.map((p, i) => {
    const q = pts[(i + 1) % 4];
    return [p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, q[0], q[1]];
  });
};
