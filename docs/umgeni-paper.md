# Drawing a Tiger with Mathematics: A Small Language for Fast Graphics

*A deep-dive into the Umgeni project, written for students of computer science.*

---

## 1. A question that sounds too simple

Here is a question that sounds like it should have a short answer: **how much code does it take to draw things on a screen?**

Not a rectangle — everything. Text in any font, curves, filled shapes with holes in them, smooth edges, stroked outlines with round corners, all of it scaled and rotated and layered like a real application does. The software that does this on the machine you're reading this on — the graphics and font-rendering libraries inside your operating system and browser — comes to somewhere in the region of a **million lines of code**. It is some of the most impressive engineering in computing, and almost nobody alive has read all of any one implementation.

Around 2007, a research group led by Alan Kay (one of the inventors of modern personal computing) asked whether this was necessary, or just an accident of history. Their project set itself an outrageous constraint: build a complete working personal computer system — graphics included — in **twenty thousand lines total**, small enough that one person could genuinely read and understand the whole thing. For the graphics part, a researcher named Dan Amelang designed a tiny programming language called **Nile**, and rewrote 2D vector graphics — the same mathematics as the million-line libraries — in about **three hundred lines** of it.

Three hundred lines. The catch, and there is always a catch, is that Nile's original implementation ran slowly, and the project ended before that was fixed. The idea has sat in the literature ever since, admired and unused: a beautiful description of graphics that nobody could run fast.

**Umgeni** is a project that picks the idea back up with modern tools, and asks the question the original couldn't answer: *can a program this clear also be genuinely fast — fast on a CPU, and fast on a GPU?* This paper describes the language, the compiler built for it, what happened when it met a real GPU, and one idea from programming-language research that turned out to be the key to the whole thing.

---

## 2. A language where programs are pipelines

If you've written a shader for a game, you already know the most important thing about Nile: **a small program that runs on every element of a stream of data**. A fragment shader runs once per pixel; it can't loop over the whole screen or remember what it did last time, and that restriction is exactly what lets the GPU run thousands of copies of it at once.

Nile is built from a similar idea, applied to *streams*. A Nile program is a set of **kernels**. Each kernel reads a stream of values — called *tokens* — one at a time, and writes a stream of tokens out. You build programs by connecting kernels into **pipelines**, so that one kernel's output pours into the next one's input, like Unix pipes or a chain of post-processing effects.

Here is a real Nile kernel, from the graphics library, in its entirety:

```
TransformBeziers (M : Matrix) : Bezier >> Bezier
    ∀ (A, B, C)
        >> (M ⊗ A, M ⊗ B, M ⊗ C)
```

Reading it line by line:

- The **signature** says: this kernel is configured with a matrix `M`, consumes a stream of `Bezier` curves and produces a stream of `Bezier` curves (that's the `Bezier >> Bezier`).
- `∀ (A, B, C)` means *for each* token — each Bézier curve, unpacked into its three control points.
- `>>` means *output a token*: here, the same curve with each point transformed by the matrix (`⊗` is matrix-apply, defined elsewhere in Nile itself, in two lines).

That's a complete, useful graphics component: it rotates, scales and translates every curve that flows through it. No loops, no memory management, no state. Just: *for each thing, emit this*.

Two more pieces of the language do most of the remaining work. First, a kernel may carry a little **state** between tokens — declared before the `∀`, updated with a prime mark:

```
RunningSum : Real >> Real
    s = 0
    ∀ a
        s' = s + a
        >> s'
```

`s' = s + a` reads as "the next value of `s` is `s + a`". Second — and this is the clever one — a kernel can **feed tokens back into its own input** with `<<`. Watch what that does for the heart of the rasterizer, the kernel that turns curves into pixel coverage:

```
DecomposeBeziers : Bezier >> EdgeSample
    ∀ (A, B, C)
        if inside a single pixel
            >> (that pixel, its coverage contribution)
        else
            split the curve in half at its midpoint
            << (second half)  << (first half)
```

(The real body is twelve lines of floor, ceiling and midpoint arithmetic; the shape is exactly this.) If a curve is small enough to fit in one pixel, emit a measurement. Otherwise cut it in two and *post both halves back to yourself*. Recursion, expressed as plumbing. The curve subdivides itself down to pixel size, and what emerges is a stream of tiny area measurements — which later kernels sort and sum into smooth, anti-aliased coverage for every pixel the shape touches. The entire rasterizer — the thing that turns "a letter Q at 14 point" into shaded pixels — is four such kernels connected in a row:

```
Rasterize : Bezier >> CoverageSpan
    ⇒ DecomposeBeziers → SortBy (@x) → SortBy (@y) → CombineEdgeSamples
```

It is worth pausing on how strange this is compared to ordinary code. There are no arrays. There is no `for (int y = 0; y < height; y++)`. Nobody allocates a framebuffer. The program is a *description of a dataflow* — geometry in, coverage out — and everything about *how* it executes is left open. That openness is not a weakness. It is the entire point, and section 6 is about cashing it in.

### Aside: how filled shapes actually work

Since the rasterizer keeps coming up, it's worth thirty seconds on the beautiful trick underneath it, because it explains why those streams of "edge samples" are the right currency.

How do you decide whether a pixel is *inside* an arbitrary shape — one with curves, and maybe holes, like the letter **Q**? The classical answer is the **winding rule**: walk along a horizontal scanline from the left edge of the screen, and keep a running count. Every time you cross the shape's outline going one direction, add one; crossing the other direction, subtract one. Wherever the count is nonzero, you're inside. Holes fall out for free: the hole's outline is wound the opposite way, so crossing into it cancels the count back to zero. No special cases.

Anti-aliasing — those smooth, non-jagged edges — falls out of the same idea made fractional: instead of counting whole crossings, each little piece of curve contributes the *exact area* it cuts off within each pixel it touches, a number between 0 and 1. Sum the contributions and you get *coverage*: 1.0 deep inside the shape, 0.13 for a pixel the edge barely clips, 0 outside. Multiply coverage by colour and you have the smooth edges every screen you've ever used relies on.

Now the pipeline in section 2 should click into place: `DecomposeBeziers` chops curves until each piece's area contribution is knowable (that's the `EdgeSample` stream — *pixel, area, direction*); the sorts arrange samples into scanline order; and `CombineEdgeSamples` is exactly the walking-and-counting step, done once per scanline with a running total. The million-line libraries and the three-hundred-line one compute the same mathematics. The difference is purely in how much machinery surrounds it.

---

## 3. Building the language: a compiler in four honest stages

A language is just a document until something executes it. Umgeni's contribution is a **compiler** for (an extended) Nile, built in TypeScript, structured as four stages. The guiding rule, inherited from the project's philosophy, is that *every stage's output is plain data you can print and read* — no stage hides its work.

**Stage 1 — parsing.** The compiler must first turn source text into structure. Rather than writing a parser by hand (thousands of lines of fiddly character handling), Umgeni writes the *grammar* of Nile as a declarative document — about 120 lines describing what programs look like, in a formalism called a PEG — and a library (Ohm) turns that description into a working parser. The grammar is data. You can read the whole syntax of the language in one file, the same way you'd read the rules of a card game.

**Stage 2 — the AST.** Parsing produces an *abstract syntax tree*: the program as nested plain objects. `M ⊗ A` becomes `{ op: "⊗", left: {var: "M"}, right: {var: "A"} }`. Nothing clever — but crucially, it's JSON. You can save it, diff it, ship it over a network (this becomes surprisingly relevant in section 6).

**Stage 3 — the IR, where the interesting compilation happens.** IR stands for *intermediate representation*: a version of the program rewritten to be easy to optimise and translate, the way you might rewrite a maths problem into a standard form before solving it. Umgeni's IR does one big violent thing to Nile programs: it **compiles the geometry away**. In the source, a `Bezier` is a value with structure — three points, each with x and y. In the IR, it is *six numbers*, and every operation on records and points has been expanded into plain arithmetic on numbers. The `TransformBeziers` kernel above becomes six multiply-adds. A user-defined operator like `⊗` is *inlined* — its definition copied into place — so that by the time the IR exists, there are no function calls left, just formulas.

Why so brutal? Because six flat numbers is what fast hardware wants. A GPU buffer is a long array of floats. A CPU's vector units want contiguous numbers. High-level structure is for humans; the IR's job is to spend it.

**Stage 4 — code generation.** The IR is walked and printed back out as source code in a *target* language. The first target is JavaScript: each kernel becomes a small function with a `step(input, emit, feed)` shape, and pipelines become chains of them. Generated code is kept deliberately readable — here is the actual output for a state-carrying kernel, lightly trimmed:

```js
step(IN, emit, feed) {
  let A_next = S[2];              // primed state becomes explicit
  if (IN[1] === S[1]) {           // same scanline as last token?
    ...
  }
  S[2] = A_next;                  // write state back at end of step
}
```

One more design decision matters here: **how do you know the compiler is correct?** Umgeni had an unusual advantage — a previous prototype (an interpreter for the same language) that had been validated by rendering real images. So the test suite compiles the *same Nile source* with both systems, pushes the *same* input streams through, and requires **bit-for-bit identical output** — not "roughly equal", but every floating-point number exactly the same. This *differential testing* is worth remembering: when you rebuild something, the old version is the most valuable test asset you own. It caught real bugs within hours, repeatedly, all week.

---

## 4. Making it fast, part one: measure, don't guess

The first compiled benchmark: a 181-character paragraph of text, rendered through the full pipeline (fonts to pixels) in **8.5 milliseconds** on a laptop CPU. Respectable — about 120 frames per second — but the interesting part is what happened next, because it's a case study in how performance work should actually be done.

The project's rule was: **no optimisation is merged without a measurement showing it helped.** Each one got a benchmark before and after. Three rounds of this happened, and they make a nice story in miniature:

**Round 1: classic compiler optimisations — modest wins.** The compiler learned *common subexpression elimination* (spotting when the same formula is computed twice and computing it once) and *kernel fusion* (merging adjacent pipeline stages so tokens pass as function arguments instead of heap-allocated arrays). Careful, textbook stuff. Result: executed arithmetic down 8%, allocations down a lot, wall-clock time improved from 8.5ms to… 7.7ms. Real, but hardly the revolution. The lesson: modern JavaScript engines already do many of these optimisations for you at runtime; doing them yourself mostly helps other, dumber targets. (Foreshadowing.)

**Round 2: profile before optimising — the big win.** Rather than optimise harder, the next step was to *measure where the time actually went*. Answer: **78% of the entire runtime was inside the two `SortBy` stages.** All the clever arithmetic optimisations had been polishing 22% of the problem. The sort was a general-purpose comparison sort, but the keys being sorted are *pixel coordinates* — small numbers, in a known range. That is the textbook setting for a **bucket sort**: instead of comparing elements (O(n log n)), drop each one directly into a numbered bucket (O(n)). One rewritten function later: **8.5ms → 3.2ms.** The single biggest speedup of the entire project came not from the compiler at all, but from replacing an algorithm after a profiler pointed at it.

**Round 3: know what your metric can't see.** A subtle point that separates good measurement from cargo-cult measurement: each optimisation was judged by the metric that matches what it does. Fusion doesn't reduce arithmetic — it reduces *allocation* — so the "operations executed" counter couldn't see its benefit at all, while wall-clock could. If you only track one number, you will optimise for that number and go blind everywhere else.

---

## 5. The GPU, and the experiment that changed the design

If you've done any graphics programming you know the modern deal: the GPU is a different computer that lives across a bus, spectacularly good at doing the same small thing thousands of times at once, and communicating with it has rules of its own.

Nile's kernels look GPU-shaped — small, stateless-ish, per-element — so the obvious first move was: compile a simple kernel (`TransformBeziers`) to **WGSL**, the WebGPU shading language, and race it against the CPU. The compiler's IR made this almost embarrassingly direct; six multiply-adds look nearly identical in JavaScript and WGSL.

The result was a *deliberate, measured failure*, and it's the most instructive number in the project:

| batch size | CPU | GPU round trip |
|---|---|---|
| 2,000 curves | 0.1 ms | 13.5 ms |
| 200,000 curves | 6 ms | 14.4 ms |
| 2,000,000 curves | 40 ms | 23 ms |

The GPU only wins at absurd sizes. Why? A follow-up experiment isolated the cost: submitting **zero work** and waiting for the GPU to say "done" cost 13.4 milliseconds — the same as the whole round trip. Transferring 4.8 *megabytes* of data cost 1.3ms. The bytes were nearly free; the *waiting* — the synchronisation point where the CPU stops until the GPU catches up, called a **fence** — was everything.

This yields the design rule that shaped everything after: **count fences, not megabytes.** It is no use shipping one stage of your pipeline to the GPU if you then wait for the result; the wait costs more than the work. The GPU pays off only if the *entire* pipeline lives there — data uploaded once, every stage running GPU-side, and the final image drawn straight to the screen without the CPU ever asking for the data back. (Game programmers will recognise this as the reason engines obsess over draw-call batching and avoiding pipeline stalls; it's the same physics.)

So that's what was built. The rasterizer became two compute shaders in a single GPU submission:

1. **Pass A — decompose.** One GPU thread per curve. Each thread runs the curve-splitting kernel from section 2 — with the recursion turned into a small explicit stack, since shaders can't recurse — and *adds* each pixel measurement into a screen-sized grid using **atomic adds** (additions that are safe even when thousands of threads hit the same pixel at once).
2. **Pass B — resolve.** One GPU thread per *row* of pixels. Each thread walks its row left to right, keeping the running winding total, and writes final coverage.

And then a fragment shader — ordinary rasterization, the kind you know from games — draws the coverage buffer to the canvas. In the steady state the CPU submits the frame and *never waits at all*: zero fences.

The punchline numbers, rendering large amounts of text: at a 2560×2560 canvas the CPU takes 255ms; the GPU takes **24ms**, and its time barely changes with workload because it's still dominated by fixed costs. The Ghostscript Tiger — a classic 240-path vector test image, with fills, strokes and holes — pans and zooms through this pipeline in real time in a browser.

---

## 6. The big idea: a declaration is a permission slip

Everything so far is good engineering. This section is the *computer science* — the part where a programming-language idea does work that no amount of engineering could.

Here's the problem it solves. Look again at the last stage of the rasterizer, the row-walking one. In Nile it's written as a sequential loop with carried state: *keep a running total; when the pixel changes, emit; when the row changes, reset.* A compiler looking at that code sees a chain where every step depends on the previous one. **Sequential by construction.** It cannot legally run rows in parallel, because nothing in the source says the rows are independent — even though we, the humans, know they are.

For the first GPU version, the honest thing was done: that one shader was written by hand, and marked in the repository, literally, as a **debt**. The language could not express what the GPU needed to know.

The repayment was to *extend the language* — carefully, with three small constructs. Watch what each one declares:

```
Rasterize2 : Bezier >> CoverageSpan
    ⇒ DecomposeBeziers
      → GroupBy (@y, @x)
      → ReduceBy (@y, @x; a ⊕ +, h ⊕ +)
      → WindScan
      → SpansOf
```

- **`GroupBy (@y, @x)`** replaces the two sorts. But it promises deliberately *less* than a sort: it groups tokens by key, and says **nothing** about the order of tokens *within* a group. That missing promise is the point. If you need arrival order preserved you must write `GroupBy stable` — and here is the beautiful part: *an order-dependent kernel placed after a plain `GroupBy` is a compile-time error.* The compiler refuses, and tells you which word to add.
- **`ReduceBy (…; a ⊕ +, h ⊕ +)`** merges each group using `+`. Declaring the operator matters because addition is **associative and commutative** — you can regroup and reorder it freely. `(a+b)+c = a+(b+c)`, and order doesn't matter.
- **`WindScan`** uses a new clause — `with H = +[ h ] by @y` — declaring "each token sees the running sum of `h` so far, *restarting for each value of `y`*". A running total whose *segment structure* is in the source.

Now the payoff. Each declaration is precisely a **permission** the GPU backend needs:

| the source declares… | …which licenses |
|---|---|
| grouping without order | thousands of threads adding to buckets simultaneously, in whatever order they finish — the atomic grid from Pass A |
| a commutative, associative reduce | those unsynchronised additions are *correct*, not just fast |
| a scan segmented by `@y` | rows are independent — one thread per row, Pass B's parallelism |

The compiler now generates *both* GPU passes from the same Nile source that runs on the CPU. The hand-written shader is gone. And crucially, the correctness argument isn't in anyone's head — it's *checked*. Write `GroupBy stable` and the GPU backend refuses with a message explaining that stable ordering can't be atomically accumulated. Use a non-commutative operator on unordered groups: compile error. The program's parallelisability became part of its *type*, in the broad sense: a machine-checked promise.

There is one delicious wrinkle worth telling your mathematically-inclined friends. When the tests compared CPU and GPU output, they matched to within one part in 10¹⁶ — but *not exactly*. Why? Floating-point addition is **not actually associative**: `(a+b)+c` and `a+(b+c)` can differ in the last bit, because of rounding. By declaring the operator "associative", the program grants the compiler freedom that real `float` addition doesn't quite possess. The project's resolution: the declaration defines what counts as a correct answer — *any* grouping of the sum is acceptable — so the old bit-exact test was, philosophically, over-strict. When you declare algebra, you are choosing your definition of equality. Very few programmers ever get to have that thought concretely.

---

## 7. What it all adds up to

The current state of the project, concretely:

- A **language** (extended Nile) whose entire grammar fits on two pages, in which a complete 2D vector graphics system — transforms, curve flattening, stroking with round and mitred joins, clipping, anti-aliased rasterization — is a few hundred lines that read like the mathematics they implement.
- A **compiler** (about four and a half thousand lines of TypeScript) from that language to two targets: fused JavaScript for CPUs, and WGSL compute shaders for GPUs — with the parallel structure derived from declarations in the source, not hand-ported.
- **Evidence**: the paragraph-of-text benchmark improved 2.7× on CPU through measured optimisation; large canvases render ~10× faster again on GPU with zero synchronisation stalls per frame; and the Tiger runs interactively in a browser, where — a detail worth savouring — the *browser itself* performs the final compilation step, generating WGSL on page load from the compiler's intermediate representation shipped as JSON. The IR being "just data" stopped being an aesthetic preference and became a deployment mechanism.

And the meta-fact, mentioned because it is honestly part of the story: essentially all of this — parser, compiler, both backends, the language extension, the demos — was implemented in **a single long day**, as a collaboration between one human (who set direction, made the design judgements, reviewed everything, and caught the bugs that mattered by looking at pictures) and an AI coding agent (which wrote and tested the bulk of the code). What made that speed *safe* rather than reckless was the discipline in sections 3 and 4: differential tests against a trusted older implementation, golden images, and the measure-everything rule. Fast tools don't remove the need for engineering judgement; they raise the price of not having it.

## 8. What's still open (or: things someone your age could genuinely explore)

Honest projects list their gaps. The language constructs have only been proven on *one* algorithm family — they fit rasterization beautifully, but they were designed by staring at rasterization, so the real test is whether they fit the *next* problem (text layout with line-breaking is queued up, and looks harder). Some of Nile's original higher-order features — pipelines that duplicate a stream and send the copies through different sub-pipelines — still aren't supported. The text renderer wraps lines at characters, not words, and uses a hand-drawn stub font rather than real font files. The GPU tiger composites its 240 paths one at a time, which only beats the CPU on large canvases.

Every one of those is a well-shaped problem: small enough to hold in your head, real enough to matter. Which is, in the end, the actual thesis of the whole enterprise — inherited from that 2007 research project and, on the evidence of this one, still alive: **software does not have to be too big to understand.** A system where the graphics stack is three hundred readable lines, where the compiler's every intermediate step can be printed and inspected, and where the performance argument is *written in the program itself*, is a system a curious person can take apart completely. The million-line version works. But this one, you could actually *know*.

---

### If you want to dig further

- **Nile/Gezira** — Dan Amelang's original language and graphics library (the 300 lines): `github.com/damelang/nile`
- **STEPS project reports** — Viewpoints Research Institute's annual reports on the 20,000-line computer system.
- **WebGPU / WGSL** — the modern browser GPU API used here; if you've written GLSL shaders for games, WGSL will feel familiar.
- **"Stream Fusion"** (Coutts, Leshchinskiy & Stewart, 2007) — the functional-programming take on why pipelines can compile into single loops.
- **Vello** (`github.com/linebender/vello`) — a production-grade GPU vector renderer built on the same compute-shader ideas as section 5, for comparison with the real thing.
