# demos

Pages that draw with Nile compiled by umgeni. `npm run demo:serve` from the
root builds `dist/` and serves it; `npm run demo:build` just builds.

- **text** (`index.html`): text set through gezira's rasterizer. Glyph
  outlines come from TrueType fonts ([src/text/ttf.ts](src/text/ttf.ts) reads
  them; Source Serif 4 is bundled) and colour emoji (Twemoji Mozilla). Word
  wrapping is written in Nile ([nl/text.nl](nl/text.nl)). The page can run
  the same Nile three ways: on the CPU compiled to JavaScript, on the CPU
  compiled to WebAssembly, or on the GPU (reading the result back, or drawing
  it straight to the canvas).
- **tiger**: the Ghostscript tiger. Every path is filled and stroked by
  gezira's own kernels; [nl/vector.nl](nl/vector.nl) connects them and
  [nl/svg.nl](nl/svg.nl) interprets the SVG path commands. JavaScript,
  WebAssembly or GPU, the same Nile each way.
- **strokes**: gezira's stroker (caps, joins, mid-stream `⇒`), drawn
  interactively on the CPU.
- **paint**: gezira's textures, gradients, compositing and filters. The
  compiler runs in the browser here, so a scene's Nile can be edited and
  recompiled; the paint is lowered to a GPU shader where it can be.
- **samples** (`samples.html`): Cairo's nineteen samples, each one's C beside
  the same picture drawn by Nile, with the Nile that drew it. Paths are built
  in TypeScript ([src/samples/path.ts](src/samples/path.ts), with text as a
  path from the font); fill, stroke, clip, paint and the transforms (composed
  and inverted by [nl/vector.nl](nl/vector.nl)) are Nile
  ([src/samples/draw.ts](src/samples/draw.ts)). The three samples that
  paint with an image use `ReadImage`, a process the host supplies (Nile has
  no memory to read); their image is the tiger, drawn by the same Nile. The
  Nile written for these pages beyond gezira: the even-odd fill rule
  ([nl/evenodd.nl](nl/evenodd.nl)), dashes and a stroker that caps each
  piece ([nl/dash.nl](nl/dash.nl)), clipping to a shape and masking
  ([nl/clip.nl](nl/clip.nl)), the samples' gradients and image painting
  ([nl/samples.nl](nl/samples.nl)), and a twentieth card, a mesh gradient:
  a Coons patch cut into pieces and summed per pixel ([nl/patch.nl](nl/patch.nl)),
  exact but slow (a 200-pixel patch takes over a second on the CPU).

A page imports a Nile library as `import { nile } from './nl/vector.nl-lib'`.
The `.nl-lib` file lists the `.nl` sources, and the bundler plugin
([tools/nile-plugin.ts](tools/nile-plugin.ts)) compiles them at build time, so
the pages ship generated JavaScript (`nile`), the same library compiled to
WebAssembly (`nileWasm`) and the compiled pipelines' intermediate form for
the GPU, not the compiler. The paint page is the exception.

`tools/` also holds the benchmarks and the Deno scripts that check the GPU
against the CPU (`check-tiger-gpu.ts`, `check-paint-gpu.ts`, `check-present.ts`,
`check-lowering.ts`).
