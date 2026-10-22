// The demos through the WebAssembly backend: bit-identical to JS (see
// umgeni/test/wasm.test.ts), on whole programs — text through word wrapping
// and the rasterizer, and the whole tiger.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { read } from '../src/sources.js';
import { compileTextPipeline, renderText } from '../src/text/render.js';
import { parseTrueType } from '../src/text/ttf.js';
import { compileVectorPipeline } from '../src/vector/compile.js';
import { parseSvg } from '../src/vector/svg.js';
import { drawTiger, fitView } from '../src/vector/tiger.js';

describe('wasm backend: bit-identical to JS', () => {
  it('text: stub font and Source Serif, through word wrapping and the rasterizer', () => {
    const js = compileTextPipeline();
    const wasm = compileTextPipeline(undefined, { target: 'wasm' });
    const font = parseTrueType(readFileSync(new URL('../fonts/SourceSerif4.ttf', import.meta.url)));
    const text = 'Here is a question that sounds like it should have a short answer.\nThree hundred lines.';
    for (const glyphs of [undefined, font.glyphFor]) {
      const opts = { size: 20, width: 400, height: 120, glyphs, lineHeight: glyphs ? font.lineHeight : undefined };
      const a = renderText(js, text, opts).spans;
      expect(a.length).toBeGreaterThan(1000);
      expect(renderText(wasm, text, opts).spans).toEqual(a);
    }
  });

  it('the whole tiger', () => {
    const tiger = parseSvg(read('demos/tiger.svg'), compileVectorPipeline().api);
    const img = (opts: object) => {
      const im = { width: 96, height: 96, data: new Uint8ClampedArray(96 * 96 * 4).fill(255) };
      drawTiger(im, tiger, fitView(96, 96), compileVectorPipeline(undefined, opts).api);
      return im.data;
    };
    expect(img({ target: 'wasm' })).toEqual(img({}));
  });
});
