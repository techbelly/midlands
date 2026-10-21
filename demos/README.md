# demos

Pages that render with umgeni-compiled Nile. `npm run demo:serve` from the root
builds `dist/` and serves it.

- **text** (`index.html`): text through gezira's rasterizer. Glyphs come from
  TrueType outlines ([src/text/ttf.ts](src/text/ttf.ts), Source Serif 4) and
  colour emoji (Twemoji Mozilla). Word wrapping is in Nile
  ([nl/text.nl](nl/text.nl)). The page can rasterize on the CPU (JS or wasm)
  or on the GPU (WebGPU).
- **tiger**: the Ghostscript tiger. Every path is filled and stroked by
  gezira's own kernels ([nl/vector.nl](nl/vector.nl) connects them).
- **strokes**: gezira's stroker (caps, joins, mid-stream `⇒`), drawn
  interactively.
- **paint**: gezira's textures, gradients, compositing and filters. The
  compiler runs in the browser here, so a scene's Nile can be edited.

`tools/` holds the build, benchmarks, and Deno scripts that check the GPU
paths against the CPU.
