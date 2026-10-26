# demos

Pages that draw with Nile compiled by umgeni. `npm run demo:serve` from the
root builds `dist/` and serves it; `npm run demo:build` just builds.

- **text** (`index.html`): text set through gezira's rasterizer. Glyph
  outlines come from TrueType fonts ([src/text/ttf.ts](src/text/ttf.ts) reads
  them; Source Serif 4 is bundled) and colour emoji (Twemoji Mozilla). Word
  wrapping is written in Nile ([roda/text.nl](../roda/text.nl)). The page can run
  the same Nile three ways: on the CPU compiled to JavaScript, on the CPU
  compiled to WebAssembly, or on the GPU (reading the result back, or drawing
  it straight to the canvas).
- **tiger**: the Ghostscript tiger. Every path is filled and stroked by
  gezira's own kernels; [roda/vector.nl](../roda/vector.nl) connects them and
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
  path from the font); fill, stroke, clip, paint and the transforms are
  Nile ([src/samples/draw.ts](src/samples/draw.ts)), nearly all of it
  [roda](../roda/): the even-odd rule, dashes, clipping to a shape, image
  painting through `ReadImage` (a process the host supplies; the image is
  the tiger, drawn by the same Nile), and a twentieth card, a mesh gradient,
  exact but slow (a 200-pixel patch takes over a second on the CPU). What
  is the samples' own is [nl/samples.nl](nl/samples.nl): Cairo's two
  gradients. The
  renderer menu moves the rasterizing to the GPU for the cards the presenter
  can draw (fills and strokes, under either rule, through `RasterizePixels`
  and `RasterizePixelsEvenOdd` lowered in the browser); the others say why
  they stay on the CPU. `npm run check:samples` runs the samples' own
  pipelines that lower (the even-odd rule, the clip join, the mesh) on a real
  GPU against the CPU.

The pages other than samples are fragments in [pages/](pages/): a title, a
one-line lede, the renderer switcher, the demo, how to use it, its static
stats, any extra pipeline panels, and the long description, each in a
`<section slot="…">`. [tools/shell.mjs](tools/shell.mjs) assembles them in
one fixed order with the shared nav, styles and footer, so the pages read
the same way and cannot drift: title, switcher, demo, the live performance
line (`#perf`), how to use, the live counts (`#stats`) and the size line,
the Nile pipeline (`#nile`), description.

A page imports a Nile library as `import { nile } from './nl/vector.nl-lib'`.
The `.nl-lib` file lists the `.nl` sources (gezira's, roda's, and the page's
own in `nl/`), and the bundler plugin
([tools/nile-plugin.ts](tools/nile-plugin.ts)) compiles them at build time, so
the pages ship generated JavaScript (`nile`), the same library compiled to
WebAssembly (`nileWasm`) and the compiled pipelines' intermediate form for
the GPU, not the compiler. The paint page is the exception.

`tools/` also holds the benchmarks and the Deno scripts that check the GPU
against the CPU (`check-tiger-gpu.ts`, `check-paint-gpu.ts`, `check-present.ts`,
`check-lowering.ts`, `check-samples-gpu.ts`).
