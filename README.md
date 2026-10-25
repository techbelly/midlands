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
| [umgeni/](umgeni/) | a compiler for (extended) Nile → JavaScript, WebAssembly and WebGPU | ~5,300 lines of TypeScript, 1,200 of them the GPU back end and 600 the WebAssembly one |
| [mooi/](mooi/) | a small language for writing down what a language means, as equations; Nile's meaning is 252 lines of it | ~360 lines |
| [demos/](demos/) | text (TrueType and colour emoji), the Ghostscript tiger, strokes, a paint gallery | |
| [docs/](docs/) | design notes, research notes | |

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
