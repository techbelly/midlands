// The demos through the WebAssembly backend: bit-identical to JS (see
// umgeni/test/wasm.test.ts), on whole libraries — text through word wrapping
// and the rasterizer, and the whole tiger.
import { describe, expect, it } from 'vitest';
import { compileLibraryFile, read } from '../src/sources.js';
import { renderText } from '../src/text/host.js';
import { blankImage } from '../src/vector/spans.js';
import { sourceSerif } from './fixtures.js';
import { parseSvg } from '../src/vector/svg.js';
import { drawTiger, fitView } from '../src/vector/tiger.js';

describe('wasm backend: bit-identical to JS', () => {
  it('text: stub font and Source Serif, through word wrapping and the rasterizer', () => {
    const js = compileLibraryFile('demos/nl/text.nl-lib');
    const wasm = compileLibraryFile('demos/nl/text.nl-lib', { target: 'wasm' });
    const font = sourceSerif();
    const text = 'Here is a question that sounds like it should have a short answer.\nThree hundred lines.';
    for (const glyphs of [undefined, font.glyphFor]) {
      const opts = { size: 20, width: 400, height: 120, glyphs, lineHeight: glyphs ? font.lineHeight : undefined };
      const a = renderText(js, text, opts).spans;
      expect(a.length).toBeGreaterThan(1000);
      expect(renderText(wasm, text, opts).spans).toEqual(a);
    }
  });

  it('the whole tiger', () => {
    const tiger = parseSvg(read('demos/tiger.svg'), compileLibraryFile('demos/nl/vector.nl-lib').api);
    const img = (opts: object) => {
      const im = blankImage(96, 96);
      drawTiger(im, tiger, fitView(96, 96), compileLibraryFile('demos/nl/vector.nl-lib', opts).api);
      return im.data;
    };
    expect(img({ target: 'wasm' })).toEqual(img({}));
  });
});
