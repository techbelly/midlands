import { describe, expect, it } from 'vitest';
import { gezira } from './sources.js';
import { parseModule, parseProgram } from '../src/parser.js';
import { emptyOpTable } from '../src/ops.js';
import { preprocess, EOL, INDENT, DEDENT } from '../src/preprocess.js';


// types.nl defines the operators the rest of the corpus uses, so it comes
// first — mirroring the module order of the original Gezira build.
const CORPUS = [
  'types.nl',
  'bezier.nl',
  'rasterize.nl',
  'compositor.nl',
  'texture.nl',
  'gradient.nl',
  'filter.nl',
  'stroke.nl',
];

describe('preprocess', () => {
  it('encodes indentation with sentinels', () => {
    expect(preprocess('a\n    b\n    c\nd\n')).toBe(
      `a${EOL}${INDENT}b${EOL}c${EOL}${DEDENT}d${EOL}`,
    );
  });

  it('closes open blocks at end of file', () => {
    expect(preprocess('a\n  b\n    c\n')).toBe(
      `a${EOL}${INDENT}b${EOL}${INDENT}c${EOL}${DEDENT}${DEDENT}`,
    );
  });

  it('joins lines inside brackets', () => {
    expect(preprocess('a (1,\n      2)\n')).toBe(`a (1, 2)${EOL}`);
  });

  it('joins lines after a trailing pipeline arrow', () => {
    expect(preprocess('x →\n    y\n')).toBe(`x → y${EOL}`);
  });

  it('skips blank lines', () => {
    expect(preprocess('a\n\n   \nb\n')).toBe(`a${EOL}b${EOL}`);
  });
});

describe('operator scanning', () => {
  it('collects fixities from types.nl', () => {
    const { table } = parseModule(gezira('types.nl'));
    expect(table.prefix).toEqual(new Set(['¬', '^']));
    expect(table.outfix).toEqual(new Map([['|', '|'], ['‖', '‖']]));
    for (const op of ['?', '%', '◁', '▷', '~', '⊕', '=#', '≠#', '≠*', '?*', '∙', '⟂', '⊗']) {
      expect(table.infix, `infix ${op}`).toContain(op);
    }
  });
});

describe('gezira corpus', () => {
  it('parses every file', () => {
    const { modules } = parseProgram(CORPUS.map(gezira));
    const names = modules.flatMap((m) =>
      m.decls.filter((d) => d.kind === 'kernel').map((d) => d.name),
    );
    expect(names).toContain('DecomposeBeziers');
    expect(names).toContain('StrokeBezierPath');
    expect(names.length).toBeGreaterThan(50);
  });
});

describe('AST shape', () => {
  const typesTable = () => parseModule(gezira('types.nl')).table;

  it('builds a simple kernel', () => {
    const src = 'TransformBeziers (M : Matrix) : Bezier >> Bezier\n    ∀ (A, B, C)\n        >> (M ⊗ A, M ⊗ B, M ⊗ C)\n';
    const { module } = parseModule(src, typesTable());
    expect(module.decls[0]).toEqual({
      kind: 'kernel',
      name: 'TransformBeziers',
      params: [{ names: ['M'], type: { kind: 'namedType', name: 'Matrix' } }],
      type: {
        kind: 'streamType',
        input: { kind: 'namedType', name: 'Bezier' },
        output: { kind: 'namedType', name: 'Bezier' },
      },
      prologue: [],
      forAlls: [{
        kind: 'forAll',
        pattern: {
          kind: 'tuplePat',
          elements: [
            { kind: 'varPat', name: 'A' },
            { kind: 'varPat', name: 'B' },
            { kind: 'varPat', name: 'C' },
          ],
        },
        cons: null,
        consKey: null,
        scan: null,
        body: [
          {
            kind: 'out',
            exprs: [
              {
                kind: 'tuple',
                elements: ['A', 'B', 'C'].map((v) => ({
                  kind: 'binOp',
                  op: '⊗',
                  left: { kind: 'var', name: 'M' },
                  right: { kind: 'var', name: v },
                })),
              },
            ],
          },
        ],
      }],
      epilogue: [],
    });
  });

  it('parses windowed arms, scan clauses, and GroupBy/ReduceBy stages', () => {
    const src = [
      'W : Real >> Real',
      '    ∀ p ∷ q',
      '        >> p + q',
      '    ∀ p ∷ ∅',
      '        >> p',
      'S : Real >> Real',
      '    ∀ (x, y, a, h) with H = +[ h ] by @y',
      '        >> H + a',
      'P : Real >> Real',
      '    ⇒ GroupBy (@y, @x) → ReduceBy (@y, @x; a ⊕ +, h ⊕ ◁) → W',
      'Q : Real >> Real',
      '    ⇒ GroupBy stable (@y) → W',
    ].join('\n');
    const { module } = parseModule(src);
    const [w, s, p, q]: any[] = module.decls;
    expect(w.forAlls).toHaveLength(2);
    expect(w.forAlls[0].cons).toEqual({ kind: 'varPat', name: 'q' });
    expect(w.forAlls[1].cons).toBe('end');
    expect(s.forAlls[0].scan).toMatchObject({ name: 'H', op: '+', key: 'y' });
    expect(p.prologue[0].pipeline[0]).toEqual({ kind: 'groupBy', keys: ['y', 'x'], stable: false });
    expect(p.prologue[0].pipeline[1]).toEqual({
      kind: 'reduceBy',
      keys: ['y', 'x'],
      fields: [{ name: 'a', op: '+' }, { name: 'h', op: '◁' }],
    });
    expect(q.prologue[0].pipeline[0]).toEqual({ kind: 'groupBy', keys: ['y'], stable: true });
  });

  it('parses conditional expressions with cases', () => {
    const src = 'K : Real >> Real\n    ∀ a\n        >> {1 if a < 0, 2 if a = 0, 3}\n';
    const { module } = parseModule(src);
    const kernel: any = module.decls[0];
    const out = kernel.forAlls[0].body[0];
    expect(out.exprs[0].kind).toBe('cond');
    expect(out.exprs[0].cases).toHaveLength(2);
    expect(out.exprs[0].otherwise).toEqual({ kind: 'num', value: 3 });
  });

  it('distinguishes decl from primed assignment', () => {
    const src = "K : Real >> Real\n    s = 0\n    ∀ a\n        s' = s + a\n    >> s\n";
    const { module } = parseModule(src);
    const kernel: any = module.decls[0];
    expect(kernel.prologue[0]).toEqual({
      kind: 'decl', name: 's', type: null, value: { kind: 'num', value: 0 },
    });
    expect(kernel.forAlls[0].body[0].kind).toBe('assign');
    expect(kernel.forAlls[0].body[0].name).toBe('s');
    expect(kernel.epilogue[0].kind).toBe('out');
  });

  it('parses feedback (<<) and forwarding (⇒), including inside if-branches', () => {
    const src = [
      'K (o : Real) : Bezier >> Bezier',
      '    ∀ Z',
      '        if o < 0',
      '            ⇒ K (o) → (→)',
      '        else',
      '            << (Z, Z, Z)',
    ].join('\n');
    const { module } = parseModule(src);
    const kernel: any = module.decls[0];
    const ifStmt = kernel.forAlls[0].body[0];
    expect(ifStmt.kind).toBe('if');
    expect(ifStmt.then[0].kind).toBe('forward');
    expect(ifStmt.then[0].pipeline).toEqual([
      { kind: 'kernelApp', name: 'K', args: [{ kind: 'var', name: 'o' }] },
      { kind: 'identityPipeline' },
    ]);
    expect(ifStmt.else[0].kind).toBe('in');
  });

  it('parses higher-order pipeline arguments', () => {
    const src = [
      'F (t : Texture) : Texture',
      '    ⇒ DupZip (Points → t, Weights) → Sum (4)',
    ].join('\n');
    const { module } = parseModule(src);
    const fwd: any = (module.decls[0] as any).prologue[0];
    expect(fwd.pipeline[0].args[0]).toEqual({
      kind: 'pipelineArg',
      elements: [{ kind: 'kernelRef', name: 'Points' }, { kind: 'kernelRef', name: 't' }],
    });
    expect(fwd.pipeline[0].args[1]).toEqual({ kind: 'var', name: 'Weights' });
    expect(fwd.pipeline[1]).toEqual({
      kind: 'kernelApp', name: 'Sum', args: [{ kind: 'num', value: 4 }],
    });
  });

  it('parses sort-key offsets', () => {
    const src = 'R : Bezier >> CoverageSpan\n    ⇒ D → SortBy (@x) → C\n';
    const { module } = parseModule(src);
    const fwd: any = (module.decls[0] as any).prologue[0];
    expect(fwd.pipeline[1].args[0]).toEqual({ kind: 'offset', field: 'x' });
  });

  it('round-trips modules as plain JSON data', () => {
    const { module } = parseModule(gezira('rasterize.nl'), typesTable());
    expect(JSON.parse(JSON.stringify(module))).toEqual(module);
  });

  it('reports a useful error on bad input', () => {
    expect(() => parseModule('K : Real >> Real\n    ∀ a\n        >> +++\n', emptyOpTable()))
      .toThrowError(/^line 3, col \d+: /);
  });

  it('reports the physical line and column inside a joined logical line', () => {
    // Lines 2–3 are one logical line (open bracket); the error is the ⇒ on line 3.
    const src = 'K : Real >> Real\n    ⇒ A (1,\n         2 ⇒ 3)\n';
    expect(() => parseModule(src, emptyOpTable())).toThrowError(/^line 3, col 12: /);
  });
});

describe('comments', () => {
  it('drops -- comments to end of line, including whole-line ones', () => {
    const src = '-- a kernel\nId : Real >> Real -- signature\n    ∀ x -- each\n        >> x\n';
    const { modules } = parseProgram([src]);
    expect(modules[0].decls.map((d) => (d as { name: string }).name)).toEqual(['Id']);
  });
});
