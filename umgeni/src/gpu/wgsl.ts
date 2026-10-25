// WGSL code generation for map-class kernels: one thread per input token.
//
// The scalar IR ports almost directly — pure f32 arithmetic, structured
// control flow, single-assignment locals. The two representational shifts:
// WGSL comparisons yield bool (numeric context materializes 0.0/1.0 via
// select; boolean context stays native, mirroring the JS boolCond pass), and
// state slots are folded into the parameter buffer by the host (a map kernel
// never writes state — see gpu/eval.ts).
//
// PRECISION: WGSL computes in f32; the reference backend in f64. GPU output
// is compared with tolerances, not bit-equality.

import { allStmts, type KernelIR, type ScalarExpr, type Stmt } from '../ir.js';
import { renderCond, renderExpr, type Dialect } from '../scalar.js';

function fmt(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return v < 0 ? `(-${Math.abs(v)}.0)` : `${v}.0`;
  const s = String(v);
  return v < 0 ? `(${s})` : s;
}

// Local names come from Nile identifiers plus '#'-suffixed leaves and '#cse'
// temporaries; the corpus is ASCII. (Unicode identifiers are legal in modern
// WGSL but not relied on yet.) The prefix is 'v', not '_': WGSL reserves
// identifiers starting with '__', which '#cse0' would otherwise become.
function mangle(name: string): string {
  return 'v' + name.replace(/'/g, '_p').replace(/#/g, '_');
}

// How slot references and emit/feed render inside a shader — the WGSL
// mirror of the JS codegen's GenEnv. Scaffolds (map dispatch, worklist
// loops) plug kernel bodies into their own plumbing through this.
export interface WgslEnv {
  param(i: number): string;
  state(i: number): string;
  input(i: number): string;
  emit(vals: string[], indent: string): string;
  feed(vals: string[], indent: string, tail: boolean): string; // tail: passes/tail.ts
  /** Local-name rendering override (e.g. a per-stage prefix when several
   *  kernel bodies share one shader function). Defaults to the module
   *  mangler. */
  local?(name: string): string;
}

// WGSL is the C-like rendering of scalar.ts with WGSL spellings.
const dialect = (c: WgslEnv): Dialect => ({
  num: fmt,
  leaf: (e) =>
    e.k === 'param' ? c.param(e.index)
    : e.k === 'state' ? c.state(e.index)
    : e.k === 'input' ? c.input(e.index)
    : c.local ? c.local((e as { name: string }).name) : mangle((e as { name: string }).name),
  ofBool: (b) => `select(0.0, 1.0, ${b})`,
  truthy: (x) => `(${x} != 0.0)`,
  select: (b, x, y) => `select(${y}, ${x}, ${b})`,
  fn: (f) => f,
  eq: '==',
  ne: '!=',
  boolCond: true,
});
const expr = (e: ScalarExpr, c: WgslEnv) => renderExpr(e, dialect(c));
const cond = (e: ScalarExpr, c: WgslEnv) => renderCond(e, dialect(c));

// A single expression, for scaffolds that bind values themselves.
export const wgslExpr = (e: ScalarExpr, c: WgslEnv): string => expr(e, c);

// Generate a kernel body as WGSL statements against an environment. This is
// the exported seam: scaffolds wrap it in their own dispatch/worklist code.
export function wgslBody(list: Stmt[], indent: string, c: WgslEnv, mutable = assignedNames(list)): string {
  const lines: string[] = [];
  const name = (n: string) => (c.local ? c.local(n) : mangle(n));
  for (const s of list) {
    switch (s.k) {
      case 'let':
        // Primed state locals are reassigned, so they are WGSL vars.
        lines.push(`${indent}${mutable.has(s.name) ? 'var' : 'let'} ${name(s.name)} = ${expr(s.expr, c)};`);
        break;
      case 'assign':
        lines.push(`${indent}${name(s.name)} = ${expr(s.expr, c)};`);
        break;
      case 'emit':
        lines.push(c.emit(s.values.map((v) => expr(v, c)), indent));
        break;
      case 'feed':
        lines.push(c.feed(s.values.map((v) => expr(v, c)), indent, s.tail === true));
        break;
      case 'setState':
        // Valid only where the env's state is mutable (thread-local arrays);
        // map kernels never contain setState by classification.
        lines.push(`${indent}${c.state(s.index)} = ${expr(s.expr, c)};`);
        break;
      case 'if':
        lines.push(`${indent}if (${cond(s.cond, c)}) {`);
        lines.push(wgslBody(s.then, indent + '  ', c, mutable));
        if (s.else.length > 0) {
          lines.push(`${indent}} else {`);
          lines.push(wgslBody(s.else, indent + '  ', c, mutable));
        }
        lines.push(`${indent}}`);
        break;
      default:
        throw new Error(`statement '${(s as Stmt).k}' has no WGSL lowering`);
    }
  }
  return lines.filter((l) => l !== '').join('\n');
}

const assignedNames = (list: Stmt[]) =>
  new Set([...allStmts(list)].flatMap((s) => (s.k === 'assign' ? [s.name] : [])));

export const WORKGROUP_SIZE = 64;

export function genMapShader(k: KernelIR): string {
  const c: WgslEnv = {
    param: (i) => `P[${i}u]`,
    state: (i) => `P[${k.paramWidth + i}u]`,
    input: (i) => `INBUF[inBase + ${i}u]`,
    emit: (vals, indent) =>
      vals.map((v, i) => `${indent}OUTBUF[outBase + ${i}u] = ${v};`).join('\n'),
    feed: () => {
      throw new Error('map kernels cannot feed');
    },
  };
  return [
    `// generated from Nile kernel ${k.name} (map class)`,
    `// P layout: [0..${k.paramWidth}) params, [${k.paramWidth}..) folded state`,
    `struct Meta { n : u32 }`,
    `@group(0) @binding(0) var<uniform> META : Meta;`,
    `@group(0) @binding(1) var<storage, read> P : array<f32>;`,
    `@group(0) @binding(2) var<storage, read> INBUF : array<f32>;`,
    `@group(0) @binding(3) var<storage, read_write> OUTBUF : array<f32>;`,
    ``,
    `@compute @workgroup_size(${WORKGROUP_SIZE})`,
    `fn main(@builtin(global_invocation_id) gid : vec3<u32>) {`,
    `  let i = gid.x;`,
    `  if (i >= META.n) { return; }`,
    `  let inBase = i * ${k.inputWidth}u;`,
    `  let outBase = i * ${k.outputWidth}u;`,
    wgslBody(k.body, '  ', c),
    `}`,
    ``,
  ].join('\n');
}
