# midlands

Small languages and runtimes, to get powerful results in very few lines of code.

In 2012 Dan Amelang's [gezira](https://github.com/damelang/gezira) showed that
the core of a 2D graphics library like Cairo, which is about 100,000 lines of C,
could be written in about 500 lines of [Nile](https://github.com/damelang/nile),
a language of stream processes. midlands picks that work up again, and then
applies the same idea to the compiler.

| part | what it is | size |
|---|---|---|
| [gezira/](gezira/) | Amelang's gezira kernels, unmodified: Béziers, strokes, rasterization, textures, gradients, compositing, filters | ~500 lines of Nile |
| [umgeni/](umgeni/) | a compiler for (extended) Nile → JavaScript, WebAssembly and WebGPU | ~3,800 lines of TypeScript |
| [mooi/](mooi/) | an equational language for writing compilers' semantics; umgeni's front end is ~170 lines of it | ~320 lines |
| [demos/](demos/) | text (TrueType and colour emoji), the Ghostscript tiger, strokes, a paint gallery | |
| [docs/](docs/) | a long-form introduction, design notes, research notes | |

umgeni compiles gezira's source unmodified. Its output is checked bit for
bit against the original 2012 C runtime, which is built from Amelang's
repositories with every `float` widened to `double`. Nile's meaning is defined
once, in Mooi ([nile.mooi](umgeni/src/semantics/nile.mooi)):

- Run on symbolic values, that definition is the compiler's front end.
- Run on numbers, it is an interpreter.
- The tests require the two to agree, kernel by kernel.

## Running it

```sh
npm ci
npm test              # every suite: oracles, backends, demos
npm run typecheck
npm run demo:serve    # build demos/dist and serve it
```

The demos are a static site (`npm run demo:build` → `demos/dist`). They use
WebGPU where the browser has it. The GPU checks and benchmarks run under
[Deno](https://deno.com), which has WebGPU: see `package.json`.

## Where to start reading

- [docs/umgeni-paper.md](docs/umgeni-paper.md): the whole project, written for students.
- [docs/research-compiler-like-gezira.md](docs/research-compiler-like-gezira.md):
  how the compiler came to be written as Nile's semantics.
- [umgeni/src/semantics/nile.mooi](umgeni/src/semantics/nile.mooi): what a Nile kernel means.

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
