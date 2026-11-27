# roda

The Nile written beyond gezira: what a 2D graphics library needs that
Amelang's 600 lines did not cover, in about 450 more. Gezira is the island
in the Nile at Cairo; Roda is the island beside it.

Each file is one idea, and each is plain Nile apart from the declared access
patterns umgeni adds (`GroupBy`, `ReduceBy`, running sums `with H = +[…]`,
adjacent pairs `p ∷ q`), which are what let a pipeline lower to the GPU.

| file | what it adds | lines |
|---|---|---|
| [vector.nl](vector.nl) | cubic Béziers (gezira's are quadratic): flattening, transforms; affine maps composed (`∘`), inverted (`⁻¹`), and `Compose`, which folds a list of maps for a host; fill and stroke pipelines from cubics | 52 |
| [rasterize-parallel.nl](rasterize-parallel.nl) | a rasterizer said once, `RasterizeBy`: curves cut into edge samples, the samples summed by pixel in any order (`GroupBy → ReduceBy`), the sums run along each row, the winding turned into coverage. The cutting and the fill rule are its two parameters; gezira's cutting with the non-zero rule is `RasterizeParallel`, which the GPU lowers | 35 |
| [rasterize-exact.nl](rasterize-exact.nl) | a rasterizer exact for the curve it is given: a quadratic cut where it turns and where it meets the pixel grid, each piece saying the area under the curve itself. gezira's moves a split point onto the grid when it is within a tenth of a pixel, and takes a piece as its chord; this one's coverage follows its control points smoothly, so its derivative is the area's, and the CPU and the GPU agree on it | 92 |
| [spans.nl](spans.nl) | coverage spans painted in one colour, as pixels for a host to write | 19 |
| [evenodd.nl](evenodd.nl) | the even-odd fill rule: one operator folding the winding into a triangle wave | 23 |
| [dash.nl](dash.nl) | dash patterns of up to four lengths, and a stroker that caps every piece, built from gezira's offset, join and cap kernels | 62 |
| [clip.nl](clip.nl) | clipping to any shape, as a join of two pixel streams by pixel, reduced by `+` alone (the product of two coverages from their sum and sum of squares); masking by a texture's alpha | 37 |
| [image.nl](image.nl) | painting with an image, once or repeated, through `ReadImage`, a process the host supplies by signature (Nile has no memory to read) | 15 |
| [patch.nl](patch.nl) | mesh gradients: a Coons patch cut in two until a piece lies within a pixel, the pieces summed per pixel. Exact, and slow | 61 |
| [text.nl](text.nl) | text layout: word widths by a backwards running sum, greedy line breaking, placement and clipping of the glyph outlines | 53 |

The demos' manifests (`demos/nl/*.nl-lib`) list these with gezira's files;
what a page needs beyond them (SVG path commands, Cairo's sample gradients)
stays in `demos/nl`. The sizes are from `npm run sizes`.
