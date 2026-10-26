# Small enough to read

*midlands: a 2D graphics library, a compiler for it, and the language the
compiler's meaning is written in. Draft, October 2026. The sizes are from
`npm run sizes` on 2026-10-25 and rounded; the July paper,
[umgeni-paper.md](umgeni-paper.md), is the story of the compiler's first day.*

## 1. The question

How much code does it take to draw things? Not a rectangle: text in any
font, curves, filled shapes with holes, smooth edges, strokes with round
and mitred joins, all of it scaled, rotated and layered. Cairo, the library
that does this for much of the Linux desktop, is about 100,000 lines of C.
The graphics and font stack in a browser is several times that. Nobody has
read all of any one of them.

In 2012 Dan Amelang, working on the VPRI STEPS project, showed that the core
of such a library could be written in about 600 lines. His language was
Nile, a language of stream processes, and his library was gezira. The STEPS
project's bet was that a whole personal computing system could fit in
20,000 lines, small enough for one person to read, and gezira was its
graphics. The project ended before Nile ran fast, and the idea has sat in
the literature since.

midlands picks the work up again, and asks the same question of the
compiler. Gezira is short because Nile's primitives are the shape of 2D
graphics: streams of tokens, small kernels, arithmetic lifted over points
and matrices. Is there a set of primitives that is the shape of *compiling*,
so that a compiler for Nile could also be a few pages of mathematics? The
answer so far: partly. Nile's meaning is 360 lines of equations in a
language made for the purpose. The rest of the compiler, about 5,600 lines
of TypeScript, is still ordinary code, and section 9 counts it honestly.

| part | what it is | lines |
|---|---|---|
| gezira | Amelang's library, unmodified | 590 of Nile |
| roda | the library beyond gezira: cubics, dashes, clipping, images, mesh gradients, text layout, a rasterizer declared for parallel lowering | 340 of Nile |
| umgeni | the compiler: Nile to JavaScript, WebAssembly and WebGPU | 5,950, of which 360 are Mooi |
| mooi | the language Nile's meaning is written in | 370 |
| demos | text, the Ghostscript tiger, strokes, paint, Cairo's samples | 100 of Nile particular to the pages |

## 2. Nile

A Nile program is a set of processes. A process reads a stream of tokens
and writes a stream of tokens. Here is one from gezira, complete:

```
TransformBeziers (M : Matrix) : Bezier >> Bezier
    ∀ (A, B, C)
        >> (M ⊗ A, M ⊗ B, M ⊗ C)
```

The signature says the process takes a matrix, consumes Béziers and
produces Béziers. `∀ (A, B, C)` is one step per token, the token taken
apart into its three control points. `>>` emits a token. `⊗` is matrix
times point, an operator defined in Nile itself, in two lines. There are no
loops and no arrays. The process is a description of what happens to each
curve.

A process may keep state between tokens. State is declared before the `∀`
and updated with a prime: `s' = s + a` means the next value of `s` is
`s + a`. A process may also feed tokens back to its own input with `<<`.
That is how gezira turns curves into pixel coverage:

```
DecomposeBeziers : Bezier >> EdgeSample
    ∀ (A, B, C)
        inside = (⌊ A ⌋ = ⌊ C ⌋ ∨ ⌈ A ⌉ = ⌈ C ⌉)
        if inside.x ∧ inside.y
            P = ⌊ A ⌋ ◁ ⌊ C ⌋
            w = P.x + 1 - (C.x ~ A.x)
            h = C.y - A.y
            >> (P.x + 1/2, P.y + 1/2, w × h, h)
        else
            ABBC    = (A ~ B) ~ (B ~ C)
            min     = ⌊ ABBC ⌋
            max     = ⌈ ABBC ⌉
            nearmin = | ABBC - min | < 0.1
            nearmax = | ABBC - max | < 0.1
            M       = {min if nearmin, max if nearmax, ABBC}
            << (M, B ~ C, C) << (A, A ~ B, M)
```

If a curve lies within one pixel, emit the area it cuts off in that pixel
and its height. Otherwise split it at its midpoint (`~` is the midpoint
operator) and feed both halves back. The curve subdivides itself down to
pixel size. Note that `⌊ A ⌋` is the floor of a point, applied to both
coordinates, and `inside.x` picks one coordinate of a record of booleans:
every operator is defined on numbers and lifted over records. That lifting
is most of why gezira is short.

The rasterizer is this process and three more in a row:

```
Rasterize : Bezier >> CoverageSpan
    ⇒ DecomposeBeziers → SortBy (@x) → SortBy (@y) → CombineEdgeSamples
```

`CombineEdgeSamples` walks each row with a running total of the heights it
has seen, which is the winding number of the scanline, and the running
total of areas, which is the coverage of the pixel. Holes come free: the
hole's outline is wound the other way and the total returns to zero.
Anti-aliasing comes free too: the areas are fractions. Cairo computes the
same mathematics. The difference is in how much surrounds it.

## 3. The library

gezira is copied from upstream and compiled as it is; nothing in midlands
edits it. Its eight files are the types, Bézier curves, strokes (caps and
joins), rasterization, textures and gradients, compositing and filters.
Every process in it compiles, including the twelve that take another
process as a parameter.

roda is what a 2D graphics library needs that gezira did not cover, in
about 340 more lines. Each file is one idea: cubic Béziers and affine maps
(composition, inversion, a fold that composes a list of maps for the host);
the even-odd fill rule, as one operator folding the winding into a triangle
wave; dash patterns; clipping to any shape, as a join of two pixel streams;
painting with an image; mesh gradients, a Coons patch cut in two until a
piece lies within a pixel, exact and slow; and text layout.

Text layout is a fair test of writing new Nile, because line breaking needs
to know a word's width before placing its first glyph, and a stream process
only sees what has arrived. The answer is to run over the stream backwards:

```
TextLayout (w, lh : Real) : GlyphBezier >> Bezier
    ⇒ Reverse → WordWidths → Reverse → LayoutGlyphs (w, lh)
```

`WordWidths` sums advances and restarts at each space, so reversed and
reversed again, every glyph carries the width of the rest of its word.
`LayoutGlyphs` then breaks greedily. Word wrapping is 53 lines, including
the comments, and the host supplies only the glyph outlines from the font.

Cairo's nineteen samples, the ones from its documentation, each draw in the
demos beside the same picture by Nile. Paths are built in TypeScript, as
they would be against Cairo's API; fill, stroke, clip, paint and the
transforms are Nile, nearly all of it roda.

## 4. What Nile means

A compiler's hardest stage is the one that gives the program its meaning.
In umgeni that stage is a definition of Nile written as equations, in
Mooi, and the compiler is what you get by running the definition on
placeholders.

The idea is partial evaluation, specifically the observation that a
compiler is an interpreter whose input program is known and whose data is
not. Write what Nile means once, over a small set of primitive operations
on numbers. Hand it real numbers and running the definition runs the Nile:
an interpreter. Hand it placeholders that write down each operation instead
of performing it, and what gets written down is the compiled code. The same
equations do both jobs, and the test suite checks that they agree, bit for
bit, on every kernel in the corpus with random inputs.

There are eleven primitives. Four make and combine numbers: `num`, `bin`,
`un`, `select`. Seven are effects: `let` (a value computed once), `cell` (a
mutable variable), `branch`, `emit`, `feed`, `state` (a kernel's persistent
slots), and `forward` (a process becoming a pipeline mid-stream). Everything
else is defined on top. This is what the definition of an expression looks
like:

```
expr num{value} ρ                 = scalar (D.num value)
expr var{name} ρ                  = lookup ρ name
expr binOp{op, left, right} ρ     = apply op [expr left ρ, expr right ρ]
expr field{object, field} ρ       = part (expr object ρ) field
```

Each equation names the shape of syntax tree it applies to, and the first
equation that fits is used. `D` is the domain, the eleven primitives.
Emitting a token checks the value against the declared output type and
hands the leaves to the domain:

```
exec io out{exprs} ρ = each (\e -> D.emit (leaves (must (fit (expr e ρ) io.output) "a '>>' value does not fit the output type"))) exprs; ρ
```

The lifting of operators over records, the thing that lets `⌊ A ⌋` floor a
point, is a separate file, 64 lines. A value is a tree with numbers at the
leaves; a scalar fits any shape, a record fits a shape with the same fields:

```
fit v real{} | isScalar v = v
fit v sh     | isScalar v = agg sh (map (\f -> fit v f.shape) sh.fields)
fit v real{}              = null
fit v sh | length v.parts != length sh.fields = null
fit v sh = let fs = zipWith (\p f -> fit p f.shape) v.parts sh.fields
           in if all (\x -> x != null) fs then agg sh fs else null
```

Where no argument fits, the operator is applied componentwise over the
record's shape. That one rule is broadcasting, lifting and the
coordinate-wise arithmetic of the whole library.

Two more files finish the definition. One rewrites umgeni's extensions,
the running sums and adjacent-pair windows of section 7, into plain Nile
state and primed updates, and records what was declared. The other says
what a pipeline means: each stage over the stream the one before it leaves,
and the ordering discipline that the parallel back end relies on. The four
files together are 360 lines and are the only definition of Nile in the
repository. There is no second, faster version in TypeScript.

Running the definition on placeholders leaves a residue: the *scalar IR*,
in which every record has been flattened to numbers. A Bézier is six
numbers; `TransformBeziers` is six multiply-adds; a user operator has been
inlined wherever it was used. Three passes then tidy it. Adjacent kernels
are fused so a token passes as function arguments rather than an array;
repeated calculations are done once; a `<<` that nothing follows becomes
the loop's next turn rather than a push and a pop.

## 5. Mooi

Mooi is the language the definition is written in. It is a list of
equations. Each names a function, says what shape of input it applies to,
and gives the answer. Shapes are written the way the syntax tree is built,
so `add{left, right}` matches an addition node and names its parts. An
equation can carry a condition after `|`:

```
eval num{value} ρ       = value
eval add{left, right} ρ = eval left ρ + eval right ρ

plus num{value: a} num{value: b} = num{value: a + b}
plus num{value: 0} e             = e
plus a b                         = add{left: a, right: b}
```

The right-hand sides are a small expression language: anonymous functions,
`let`, `if`, lists, records with spread, `;` to do one thing then another.
Every function takes its arguments one at a time, whether written in Mooi
or handed in by the host as a plain JavaScript function. That is how a host
extends it: the equations call host functions like any other.

The implementation is three files and about 370 lines: a grammar that Ohm
parses with, an evaluator that matches shapes and tries equations in order,
and a prelude of map, folds and filter. It depends on nothing but Ohm.

Mooi came late. The compiler was first written in TypeScript, in the usual
way, and the question of whether its meaning could be written as equations
was asked in October 2026, after three back ends worked. Rewriting the
semantics in Mooi made it two to three times shorter than the TypeScript
it replaced, with the generated code byte-identical across the corpus.
That is a real gain, but it is not gezira's twenty to a hundred times.
Section 9 says why.

## 6. Three back ends

The scalar IR is plain data, and a back end is a fold over it.

JavaScript is the reference. Each fused run of kernels becomes a segment,
one function; the stages between runs that need the whole stream, such as
sorting, are functions on finite arrays. The generated code is readable,
and the test suite reads it.

WebAssembly writes a whole pipeline as one module, in bytes, with no
assembler. The kernels and the barriers between them run in the module's
memory, so tokens leave it only as the final output. Its output is bit for
bit the same as the JavaScript's, which is the test, and it is about twice
as fast on the text benchmark.

WebGPU is the interesting one, because the GPU wants a different program.
It wants thousands of threads doing the same small thing, and a stream
process is sequential by construction: each step may depend on the state
the last one left. The first GPU rasterizer had one shader written by hand,
and the repository called it a debt. Section 7 is how the debt was repaid.

One number shaped the GPU design. Under Deno's WebGPU, submitting no work
at all and waiting for the GPU to say it was done cost about 13 milliseconds.
Uploading five megabytes cost about one. The bytes were nearly free; the
wait was everything. So the rule is to count fences, not megabytes: every
stage of a pipeline lives on the GPU, the data goes up once, and the result
is drawn to the screen without the CPU asking for it back. In steady state
the tiger pans and zooms with zero waits per frame.

## 7. Declarations license parallelism

The sequential rasterizer of section 2 cannot run on a GPU as written. Two
sorts, then a row walk with carried state: nothing in the source says the
rows are independent, though they are. umgeni adds a few constructs to
Nile that say it. Here is gezira's rasterizer in them, from roda, complete:

```
WindScan : EdgeSample >> WindPix
    ∀ (x, y, a, h) with H = +[ h ] by @y
        >> (x, y, H + a, H + h)

SpansOf : WindPix >> CoverageSpan
    ∀ p ∷ q by @y
        >> (p.x, p.y, |p.c| ◁ 1, 1)
        >> (p.x + 1, p.y, |p.w| ◁ 1, q.x - p.x - 1)
    ∀ p ∷ ∅
        >> (p.x, p.y, |p.c| ◁ 1, 1)

RasterizeParallel : Bezier >> CoverageSpan
    ⇒ DecomposeBeziers → GroupBy (@y, @x) → ReduceBy (@y, @x; a ⊕ +, h ⊕ +) → WindScan → SpansOf
```

Each construct promises exactly as much as the back end needs and no more.

- `GroupBy (@y, @x)` replaces the two sorts, and promises less than a sort:
  tokens arrive grouped by key, in no particular order within a group. If
  you need arrival order you must write `GroupBy stable`, and a stage that
  reads tokens in arrival order after a plain `GroupBy` is a compile-time
  error naming the word to add.
- `ReduceBy (…; a ⊕ +, h ⊕ +)` merges each group with `+`. The operator is
  declared so the compiler can check that it is commutative, which is what
  makes the missing order harmless.
- `with H = +[ h ] by @y` is a running sum of `h`, restarting at each new
  `y`. The segment structure of the scan is in the source.
- `p ∷ q by @y` is a window of adjacent tokens within a row, and `p ∷ ∅`
  the last token of a row. The edges are pattern matches, not leaked
  initial state.

On the CPU all four are sugar. They desugar to state, primed updates and
`if`s, the kernel compiles like any other, and the result agrees with the
sequential rasterizer to within rounding. On the GPU each declaration is a
permission:

| the source declares | the lowering it licenses |
|---|---|
| groups without order, reduced by `+` | a grid that thousands of threads add into at once, with atomics, in whatever order they finish |
| a running sum by `@y` | the rows are independent: one thread per row |
| a window by `@y` | the same thread sees its row's neighbours |

The lowering applies one rule per declaration, with no knowledge of
rasterization. The check that proves this lowers three pipelines the code
was never written against (a self-feeding kernel after the window, a
transform ahead of the rasterizer, a kernel alone with its output appended)
and compares them with the CPU. The Cairo samples added three more: the
even-odd rule, a join of two coverage streams reduced by `+` alone, and a
Coons patch with 49-field tokens. Anything the rules do not cover is
refused with a message naming the declaration that would allow it, and the
page falls back to the CPU and says why.

One consequence is worth a paragraph. The GPU and CPU rasterizers agree to
within rounding, not exactly, partly because the GPU works in single
precision and partly because floating-point addition is not associative: `(a+b)+c` and `a+(b+c)` can differ in the last
bit. By declaring `+` as the reducer, the source grants a freedom that real
addition does not quite have. The resolution is that the declaration
defines what counts as correct: any grouping of the sum is an answer. The
bit-exact test the project uses everywhere else was, for this one stage,
over-strict.

## 8. How we know it is right

A compiler for a language with a history can be tested against its
ancestors, and umgeni is.

- **The 2012 runtime.** Amelang's own compiler and C runtime, built from
  pinned commits, run gezira's stroke and paint processes. Strokes on 27
  random curved paths with every cap and join agree within a millionth of a
  pixel; five paint scenes, with gradients, compositing and filters, agree
  within a billionth.
- **chari**, this project's predecessor, an earlier compiler for Nile: its
  outputs on the tiger's kernels are recorded and must match bit for bit.
- **Interpreter against compiler.** The Mooi definition on numbers against
  the Mooi definition on placeholders, every kernel, random inputs, every
  output number identical.
- **WebAssembly against JavaScript**, bit for bit, on strokes, paint, text
  in two fonts and the whole tiger.
- **The GPU against the CPU**, under Deno, which has WebGPU: the lowering
  checks above, the tiger, the paint shaders, the samples. These are
  tolerance checks, for the reason in section 7.
- **The tiger's pixel checksum** and snapshots of the generated text, so a
  change that moves a pixel is a change someone meant.

There are about 400 tests. When the compiler was simplified in October,
each experiment lived on its own branch and had to pass all of them, and
most also had to leave the generated code byte-identical across the
corpus. Several did. That is a strong form of refactoring: the output is
the same file, so the only thing that changed is how it was said.

## 9. The sizes, honestly

Counted by `npm run sizes`, lines of source with comments:

| | lines |
|---|---|
| gezira, unmodified | 593 |
| roda | 342 |
| the demos' own Nile | 104 |
| mooi | 368 |
| umgeni: Nile to syntax tree (grammar, offside rule, operators, parser) | 925 |
| umgeni: Nile's meaning, in Mooi | 361 |
| umgeni: the Mooi hosts, value algebra, substitution, the IR, the passes | 1,958 |
| umgeni: IR to JavaScript, with the CPU runtime | 836 |
| umgeni: IR to WebAssembly | 615 |
| umgeni: IR to GPU (WGSL, lowering, execution, presentation) | 1,258 |

The claim this project can make is narrower than gezira's. A 2D graphics
library in 930 lines of Nile, with a compiler to three targets in about
6,000, is a system one person can read in a few sittings. The back ends
are optional, and any one of them is a working compiler, so the smallest
reading is about 4,000 lines plus the library. But the compiler is not yet
a few pages of mathematics. The meaning of Nile is 361 lines of equations,
and 1,958 lines of TypeScript stand around them.

Some of that is substrate: the IR itself, the two domains, the shapes and
layouts of values. Some of it is meaning that has not moved. The 205 lines
that turn mid-stream `⇒` into a state machine are, the research note shows,
a specialisation of about fifteen lines of semantics, done by hand. The 226
lines of common subexpression elimination are sharing in the residue, which
a different domain could do for free. Templates and fusion are the same
story. A generic specialiser would absorb all three, and the estimate, not
yet a measurement, is a compiler of about 1,100 lines with the back ends
written as models of the eleven primitives in Mooi.

Why did notation alone give two to three times rather than twenty? Gezira's
ratio comes from one uniform domain, geometry on streams, and a runtime
that absorbs the plumbing. A compiler has more distinct concerns than that,
and each needs its own small language or its own engine. The gain comes one
concern at a time.

## 10. What is open

- A generic specialiser, replacing the hand-written handling of `⇒`,
  templates and fusion, with the research note's experiment as its oracle.
- Back ends as models of the domain signature, in Mooi.
- Mesh gradients are exact and slow: a 200-pixel patch takes over a second
  on the CPU. Their lowering works but the presenter has no coloured-pixel
  sink yet, so they stay on the CPU in the samples page.
- Text has no kerning or shaping.
- Arcs become cubics in the host, as they do in Cairo's API. Whether that is
  the host's business or Nile's is undecided.

## 11. Where it came from, and the names

Nile and gezira are Dan Amelang's, from the VPRI STEPS project led by Alan
Kay; the papers are at tinlizzie.org. Ohm, by Alessandro Warth, Patrick
Dubroy and others, parses both Nile and Mooi. The partial evaluation frame
is Futamura's (1971); the reading of the compiler's passes as staging,
specialisation and The Trick follows Jones, Gomard and Sestoft (1993) and
Amin and Rompf's *Collapsing Towers of Interpreters* (2018). Vello, from
the Linebender project, is a production GPU vector renderer built on the
same compute-shader ideas, for comparison with the real thing.

The code was written between July and October 2026 by one person
directing an AI coding agent, which wrote and tested most of it. The
oracles in section 8 are what made that safe.

Gezira is the island in the Nile at Cairo, and Roda the island beside it.
The Umgeni is a river in KwaZulu-Natal; the Mooi joins it, and is Afrikaans
for beautiful. Both rise in the Midlands.
