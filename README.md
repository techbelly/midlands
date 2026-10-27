# midlands

Small languages and runtimes, to get powerful results in very few lines of code.

In 2012 Dan Amelang's [gezira](https://github.com/damelang/gezira) showed that
the core of a 2D graphics library like Cairo, which is about 100,000 lines of C,
could be written in about 600 lines of [Nile](https://github.com/damelang/nile),
a language of stream processes. midlands picks that work up again, and then
applies the same idea to the compiler: the meaning of Nile is itself written
in a small language made for the purpose. I've been fascinated by the idea of
using domain specific languages to build a complete computing platform where
all the source code is readable, and readable in the lifespan of a human. This
is a start.

| part | what it is | size |
|---|---|---|
| [gezira/](gezira/) | Amelang's gezira kernels, unmodified: Béziers, strokes, rasterization, textures, gradients, compositing, filters | ~600 lines of Nile |
| [roda/](roda/) | the library beyond gezira: cubics and matrices, a rasterizer declared for parallel lowering, the even-odd rule, dashes, clipping to a shape, mesh gradients, images, text layout | ~340 lines of Nile |
| [umgeni/](umgeni/) | a compiler for (extended) Nile → JavaScript, WebAssembly and WebGPU | ~6,300 lines by stage: Nile → AST 900; AST → IR 2,500, of which 410 are Nile's meaning in Mooi; then a back end each, IR → JS 1,050 (with the CPU runtime), IR → wasm 680, IR → GPU 1,190 |
| [mooi/](mooi/) | a small language for writing down what a language means, as equations | ~370 lines |
| [demos/](demos/) | text (TrueType and colour emoji), the Ghostscript tiger, strokes, a paint gallery, Cairo's samples drawn by Nile | ~100 lines of Nile particular to the pages |
| [docs/](docs/) | two papers: the project's, and the compiler's first design as history | |

The sizes are counted by `npm run sizes` (lines of source, comments included;
`--files` lists the compiler file by file), and rounded here. `npm run corpus`
hashes the generated code of every library, so a change to the compiler that
should change nothing can show that it did not. The back ends
are the optional part: any one of the three is a working compiler.

## Running it

See the demos at https://techbelly.github.io/midlands/

```sh
npm ci
npm test              # every suite: oracles, back ends, demos
npm run typecheck
npm run demo:serve    # build demos/dist and serve it
```

The demos are a static site (`npm run demo:build` → `demos/dist`). They use
WebGPU where the browser has it. The checks and benchmarks that need a real
GPU run under [Deno](https://deno.com), which has WebGPU: see `package.json`.
`npm run record:gpu` stores the GPU's answers in `demos/test/fixtures`, and
`npm test` checks the CPU against them, so CI covers the lowering without a GPU.

For syntax highlighting of Nile and Mooi in VS Code, link the extension in
[tools/vscode/](tools/vscode/) into your extensions folder and reload:
`ln -s "$PWD/tools/vscode/nile-mooi" ~/.vscode/extensions/midlands.nile-mooi`.

## Credits and licences

midlands is MIT licensed ([LICENSE](LICENSE)). It builds on:

- [Nile and gezira](https://github.com/damelang) by Dan Amelang, part of the
  [VPRI STEPS](https://tinlizzie.org/VPRIPapers/) project (gezira is MIT; see
  [gezira/LICENSE](gezira/LICENSE)).
- [Ohm](https://ohmjs.org) by Alessandro Warth, Patrick Dubroy and others (MIT),
  a descendant of OMeta. It parses both Nile and Mooi.
- [Source Serif 4](https://github.com/adobe-fonts/source-serif) (SIL OFL 1.1) and
  [Twemoji](https://github.com/twitter/twemoji) by way of
  [Twemoji Mozilla](https://github.com/mozilla/twemoji-colr) (graphics CC-BY 4.0),
  used by the text demo. Both licences are in [demos/fonts/](demos/fonts/).
