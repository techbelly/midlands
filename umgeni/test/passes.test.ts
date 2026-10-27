import { describe, expect, it } from 'vitest';
import { gezira } from './sources.js';
import { compileLibrary, makeStreamer } from '../src/compile.js';
import { kernelOpCount } from '../src/ir.js';
import { cseModule } from '../src/passes/cse.js';
import { foldModule, pruneModule } from '../src/passes/simplify.js';
import { generate } from '../src/cpu/js.js';
import { run } from '../src/cpu/runtime.js';
import { needsWorklist } from '../src/passes/tail.js';
import { allNodes, allStmts, stmtExprs, type KernelIR } from '../src/ir.js';

function staticOps(library: ReturnType<typeof compileLibrary>, name: string): number {
  const k = library.ir.processes.find((p) => p.name === name);
  if (!k || k.k !== 'kernel') throw new Error(`no kernel ${name}`);
  return kernelOpCount(k);
}


describe('CSE pass', () => {
  it('shares duplicated subtrees introduced by operator inlining', () => {
    // ◁'s body `{ a if a < b, b }` uses `a` twice; without CSE the |x| tree
    // is duplicated inside it.
    const src = [
      '| (a : Real) | : Real',
      '    { -a if a < 0, a }',
      '(a : Real) ◁ (b : Real) : Real',
      '    { a if a < b, b }',
      'K : Real >> Real',
      '    ∀ x',
      '        >> | x - 10 | ◁ 3',
    ].join('\n');
    const plain = compileLibrary([src], { cse: false });
    const cse = compileLibrary([src], { cse: true });
    expect(cse.source).toContain('__cse'); // a shared let was introduced
    expect(staticOps(cse, 'K')).toBeLessThan(staticOps(plain, 'K'));
    for (const v of [0, 8, 9.5, 12, 20]) {
      expect(run(cse.api.K(), [[v]])).toEqual(run(plain.api.K(), [[v]]));
    }
  });

  it('does not merge values across a mutation of a primed local (epochs)', () => {
    const src = [
      'K : Real >> Real',
      '    s = 0',
      '    ∀ a',
      "        s' = a",
      "        x = (s' + 1) × (s' + 1)",
      "        s' = s' + 1",
      "        y = (s' + 1) × (s' + 1)",
      '        >> x + y',
    ].join('\n');
    const s = makeStreamer(compileLibrary([src], { cse: true }), 'K');
    // s'=2: x=9; s'=3: y=16. A stale merge would give 9+9=18.
    expect(s.push([2])).toEqual([[25]]);
  });

  it('preserves rasterizer output exactly (with boolCond too)', () => {
    const sources = [gezira('types.nl'), gezira('rasterize.nl')];
    const plain = compileLibrary(sources, { cse: false, boolCond: false });
    const opt = compileLibrary(sources, { cse: true, boolCond: true });
    const tokens = Array.from({ length: 10 }, (_, i) => [
      (i * 37) % 11, (i * 53) % 7, (i * 29) % 13, (i * 41) % 5, (i * 61) % 9, (i * 17) % 8,
    ]);
    expect(run(opt.api.Rasterize(), tokens))
      .toEqual(run(plain.api.Rasterize(), tokens));
  });
});

describe('simplify passes', () => {
  const single = (body: string[]) => compileLibrary([gezira('types.nl'), ['K : Point >> Real', '    ∀ p', ...body].join('\n')]);
  const localsOf = (library: ReturnType<typeof compileLibrary>, name: string): string[] => {
    const k = library.ir.processes.find((p) => p.name === name);
    if (!k || k.k !== 'kernel') throw new Error(`no kernel ${name}`);
    return [...allStmts(k.body)].flatMap((s) => (s.k === 'let' ? [s.name] : []));
  };

  it('folds an operation on constants, but not to infinity', () => {
    const lib = single(['        >> p.x × (1 / 2) + p.y / (1 / 0)']);
    expect(lib.source).toContain('* 0.5');
    expect(lib.source).not.toContain('(1 / 2)');
    expect(lib.source).toContain('(1 / 0)');
    expect(run(lib.api.K(), [[3, 7]])).toEqual([[1.5]]);
  });

  it('prunes a let nobody reads', () => {
    // A tuple pattern shares each component under a temp and binds the
    // names to them: b's temp has no reader, so it goes.
    const lib = single(['        (a, b) = (p.x + 1, p.y + 1)', '        >> a']);
    expect(localsOf(lib, 'K')).toEqual(['#pat#0']);
    expect(run(lib.api.K(), [[3, 7]])).toEqual([[4]]);
  });

  it('is idempotent: a second run of the scalar passes changes nothing', () => {
    const lib = compileLibrary([gezira('types.nl'), gezira('rasterize.nl'), gezira('stroke.nl')]);
    const again = pruneModule(cseModule(foldModule(lib.ir)));
    expect(generate(again, { boolCond: true })).toBe(lib.source);
  });

  it('leaves no shared let with a single reader', () => {
    const lib = compileLibrary([gezira('types.nl'), gezira('rasterize.nl')]);
    for (const p of lib.ir.processes) {
      if (p.k !== 'kernel') continue;
      for (const region of [p.prologue, p.body, p.flush]) {
        const reads = new Map<string, number>();
        for (const s of allStmts(region)) for (const e of stmtExprs(s)) for (const x of allNodes(e)) if (x.k === 'local') reads.set(x.name, (reads.get(x.name) ?? 0) + 1);
        for (const s of allStmts(region)) if (s.k === 'let' && s.name.startsWith('#cse')) expect(reads.get(s.name), `${p.name}: ${s.name}`).toBeGreaterThan(1);
      }
    }
  });
});

describe('sort fusion', () => {
  it('joins SortBy (@x) → SortBy (@y) into one sort by (y, x), with the same output', () => {
    const fused = compileLibrary([gezira('types.nl'), gezira('rasterize.nl')]);
    const plain = compileLibrary([gezira('types.nl'), gezira('rasterize.nl')], { fuse: false });
    const r = fused.ir.processes.find((p) => p.name === 'Rasterize');
    if (!r || r.k !== 'fused') throw new Error('Rasterize should be fused');
    expect(r.runs.filter((s) => s.k === 'sortBy')).toEqual([{ k: 'sortBy', keyIndexes: [1, 0] }]);
    const path = [[0.2, 0.3, 5.1, 3.7, 9.8, 1.1], [9.8, 1.1, 4.4, 8.9, 0.2, 0.3]];
    expect(run(fused.api.Rasterize(), path)).toEqual(run(plain.api.Rasterize(), path));
  });
});

describe('tail pass', () => {
  const kernel = (library: ReturnType<typeof compileLibrary>, name: string): KernelIR => {
    const k = library.ir.processes.find((p) => p.name === name);
    if (!k || k.k !== 'kernel') throw new Error(`no kernel ${name}`);
    return k;
  };
  it('marks a feed nothing follows, and only that one', () => {
    const library = compileLibrary([gezira('types.nl'), gezira('rasterize.nl')]);
    const feeds = [...allStmts(kernel(library, 'DecomposeBeziers').body)].filter((s) => s.k === 'feed');
    expect(feeds.map((f) => f.k === 'feed' && f.tail === true)).toEqual([false, true]);
    expect(needsWorklist(kernel(library, 'DecomposeBeziers').body)).toBe(true);
    // RectangleSpans: `>> …; << …` — its one feed is a tail feed, so no worklist.
    expect(needsWorklist(kernel(library, 'RectangleSpans').body)).toBe(false);
  });
  it('leaves prologue feeds alone and changes no output', () => {
    const on = compileLibrary([gezira('types.nl'), gezira('rasterize.nl')]);
    const off = compileLibrary([gezira('types.nl'), gezira('rasterize.nl')], { tail: false });
    expect([...allStmts(kernel(on, 'RectangleSpans').prologue)].some((s) => s.k === 'feed' && s.tail)).toBe(false);
    const spans = (lib: typeof on) => run(lib.api.RectangleSpans([1.5, 2.5, 4.5, 5.5]), []);
    expect(spans(on)).toEqual(spans(off));
    const path = [[0.2, 0.3, 5.1, 3.7, 9.8, 1.1], [9.8, 1.1, 4.4, 8.9, 0.2, 0.3]];
    expect(run(on.api.Rasterize(), path)).toEqual(run(off.api.Rasterize(), path));
  });
});
