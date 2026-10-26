// JS code generation: IR -> readable JS source.
//
// The output is a single arrow function `(rt) => { ... return R; }` mapping
// process names to factories. A factory takes the flattened parameter vector
// and returns a runtime Op. The generated source is a first-class artifact:
// compileLibrary exposes it for inspection alongside the executable form.

import { anyStmt, inputWidthOf, type FusedIR, type FusedSegment, type FusedStage, type KernelIR, type ModuleIR, type PipelineIR, type ScalarExpr, type Stmt } from '../ir.js';
import { opCount } from '../passes/cse.js';
import { compilePipeline, inWasm } from './wasm.js';
import { stageShape } from '../passes/tail.js';
import { renderCond, renderExpr, type Dialect } from '../scalar.js';

export interface CodegenOptions {
  // Emit conditions as JS booleans (`a < b`) instead of round-tripping
  // through 1/0 (`((a < b) ? 1 : 0) !== 0`). Values used as numbers still
  // materialize 1/0.
  boolCond?: boolean;
  // Instrument the module with a dynamic IR-operation counter, exposed as
  // rt.opsCounter(R). Counts bin/un/select nodes per executed statement (ternary
  // short-circuiting is not modelled: both arms count).
  countOps?: boolean;
  // Compile fused kernel segments to WebAssembly instead of JS (wasm.ts).
  // Output is bit-identical; barriers and unfused pipelines stay JS.
  target?: 'js' | 'wasm';
}

// Local names come from Nile identifiers (letters/digits, an optional prime)
// plus '#n' leaf suffixes from elaboration. Nile identifiers contain no
// underscore, so the mangled forms cannot collide.
function mangle(name: string): string {
  return '_' + name.replace(/'/g, '_p').replace(/#/g, '_');
}

// How slot references and emit/feed render: the standalone-kernel default is
// P/S/IN arrays with runtime emit/feed; fused stages rebind these (arguments
// for inputs, direct calls to the next stage for emits).
interface GenEnv {
  param(i: number): string;
  state(i: number): string;
  input(i: number): string;
  emit(vals: string[]): string;
  feed(vals: string[]): string;
  tailFeed?(vals: string[]): string; // a tail feed (passes/tail.ts): the loop's next turn
}

const KERNEL_ENV: GenEnv = {
  param: (i) => `P[${i}]`,
  state: (i) => `S[${i}]`,
  input: (i) => `IN[${i}]`,
  emit: (vals) => `emit([${vals.join(', ')}]);`,
  feed: (vals) => `feed([${vals.join(', ')}]);`,
};

// JS is the C-like rendering of scalar.ts with JS spellings.
const jsDialect = (o: CodegenOptions, env: GenEnv): Dialect => ({
  num: (v) => (v < 0 ? `(${v})` : String(v)),
  leaf: (e) =>
    e.k === 'param' ? env.param(e.index)
    : e.k === 'state' ? env.state(e.index)
    : e.k === 'input' ? env.input(e.index)
    : mangle((e as { name: string }).name),
  ofBool: (c) => `(${c} ? 1 : 0)`,
  truthy: (x) => `(${x} !== 0)`,
  select: (c, a, b) => `(${c} ? ${a} : ${b})`,
  fn: (f) => `Math.${f}`,
  eq: '===',
  ne: '!==',
  boolCond: !!o.boolCond,
});
const genExpr = (e: ScalarExpr, o: CodegenOptions, env: GenEnv) => renderExpr(e, jsDialect(o, env));
const genCond = (e: ScalarExpr, o: CodegenOptions, env: GenEnv) => renderCond(e, jsDialect(o, env));

function genStmts(stmts: Stmt[], indent: string, o: CodegenOptions, env: GenEnv): string {
  const lines: string[] = [];
  const count = (n: number) => {
    if (o.countOps && n > 0) lines.push(`${indent}OPS += ${n};`);
  };
  for (const s of stmts) {
    switch (s.k) {
      case 'let':
        count(opCount(s.expr));
        lines.push(`${indent}let ${mangle(s.name)} = ${genExpr(s.expr, o, env)};`);
        break;
      case 'assign':
        count(opCount(s.expr));
        lines.push(`${indent}${mangle(s.name)} = ${genExpr(s.expr, o, env)};`);
        break;
      case 'setState':
        count(opCount(s.expr));
        lines.push(`${indent}${env.state(s.index)} = ${genExpr(s.expr, o, env)};`);
        break;
      case 'emit':
        count(s.values.reduce((n, v) => n + opCount(v), 0));
        lines.push(`${indent}${env.emit(s.values.map((v) => genExpr(v, o, env)))}`);
        break;
      case 'feed':
        count(s.values.reduce((n, v) => n + opCount(v), 0));
        lines.push(`${indent}${(s.tail && env.tailFeed ? env.tailFeed : env.feed)(s.values.map((v) => genExpr(v, o, env)))}`);
        break;
      case 'if': {
        count(opCount(s.cond));
        lines.push(`${indent}if (${genCond(s.cond, o, env)}) {`);
        lines.push(genStmts(s.then, indent + '  ', o, env));
        if (s.else.length > 0) {
          lines.push(`${indent}} else {`);
          lines.push(genStmts(s.else, indent + '  ', o, env));
        }
        lines.push(`${indent}}`);
        break;
      }
    }
  }
  return lines.filter((l) => l !== '').join('\n');
}

// A standalone kernel is a segment of one, its arguments its own params.
function genKernel(k: KernelIR, o: CodegenOptions): string {
  const own: ScalarExpr[] = Array.from({ length: k.paramWidth }, (_, i) => ({ k: 'param', index: i }));
  return `R[${JSON.stringify(k.name)}] = (P = []) => ${genSegment([{ name: k.name, kernel: k, args: [own] }], o)};`;
}

// The runtime expression for a non-kernel stage (shared by the fused and
// unfused pipeline forms), or null for kernel stages.
function genBuiltinStage(s: Exclude<PipelineIR['stages'][number], { k: 'stage' }>, o: CodegenOptions): string {
  switch (s.k) {
    case 'sortBy':
      return `rt.sortBy([${s.keyIndexes.join(', ')}])`;
    case 'identity':
      return `rt.identity()`;
    case 'reverse':
      return `rt.reverse()`;
    case 'dupCat':
    case 'dupZip':
      return `rt.${s.k}(${s.branches.map((b) => genStages(b, o)).join(', ')})`;
    case 'groupBy':
      return `rt.groupBy([${s.keyIndexes.join(', ')}], ${s.stable})`;
    case 'reduceBy': {
      const fields = s.fields.map((f) => {
        const env: GenEnv = { ...KERNEL_ENV };
        return `{ index: ${f.index}, fn: (${mangle('#ra')}, ${mangle('#rb')}) => ${genExpr(f.op, o, env)} }`;
      });
      return `rt.reduceBy([${s.keyIndexes.join(', ')}], [${fields.join(', ')}])`;
    }
  }
}

function genStages(stages: PipelineIR['stages'], o: CodegenOptions): string {
  const ops = stages.map((s) => {
    if (s.k !== 'stage') return genBuiltinStage(s, o);
    const args = s.args.flat().map((a) => genExpr(a, o, KERNEL_ENV)).join(', ');
    return `R[${JSON.stringify(s.name)}]([${args}])`;
  });
  return `rt.pipeline([${ops.join(', ')}])`;
}

function genPipeline(p: PipelineIR, o: CodegenOptions): string {
  return `R[${JSON.stringify(p.name)}] = (P = []) => ${genStages(p.stages, o)};`;
}

// --- segments: the one execution model for kernels ---
// A run of kernels becomes one op: each stage is a local function taking its
// input token as scalar arguments; emit is a direct call to the next stage
// (the last stage calls the op's emit). A standalone kernel is a segment of
// one. A stage with feedback keeps a LIFO worklist, popping at the bottom of
// its loop so that a tail feed (passes/tail.ts) can set the inputs and go
// round again; a stage whose feeds are all tail feeds is just that loop. A
// stage with prologue statements seeds on first use (first token, or end of
// stream), so the pipeline is wired before it emits.

const stmtsFeed = (stmts: Stmt[]) => anyStmt(stmts, (s) => s.k === 'feed');

function genSegment(stages: FusedStage[], o: CodegenOptions): string {
  const lines: string[] = [];
  lines.push(`(() => { // segment: ${stages.map((s) => s.name).join(' → ')}`);
  lines.push(`  let EMIT = (t) => {};`);
  const ends: string[] = [];

  stages.forEach((stage, j) => {
    const k = stage.kernel;
    const argJs = stage.args.flat().map((a) => genExpr(a, o, KERNEL_ENV)); // over the op's P
    // A prologue that feeds (a seed) needs the worklist whatever the body does.
    const shape = stmtsFeed(k.init) ? 'worklist' : stageShape(k.body);
    const feeds = shape !== 'straight';
    const worklist = shape === 'worklist';
    const inputs = Array.from({ length: k.inputWidth }, (_, i) => `i${j}_${i}`);
    const env: GenEnv = {
      param: (i) => argJs[i],
      state: (i) => `S${j}[${i}]`,
      input: (i) => (feeds ? inputs[i] : `a${i}`),
      emit: (vals) => (j + 1 < stages.length ? `st${j + 1}(${vals.join(', ')});` : `EMIT([${vals.join(', ')}]);`),
      feed: (vals) => `q${j}.push([${vals.join(', ')}]);`,
      // The values first (they read the inputs), then the inputs.
      tailFeed: (vals) => `{ ${vals.map((v, i) => `const n${i} = ${v};`).join(' ')} ${vals.map((_, i) => `${inputs[i]} = n${i};`).join(' ')} continue; }`,
    };
    lines.push(`  const S${j} = new Float64Array(${k.stateInit.length});`);
    k.stateInit.forEach((e, i) => lines.push(`  S${j}[${i}] = ${genExpr(e, o, env)};`));
    const seed = k.init.length > 0 ? `sd${j}(); ` : '';
    if (seed) {
      lines.push(`  let seeded${j} = false;`);
      lines.push(`  function sd${j}() {`);
      lines.push(`    if (seeded${j}) return;`);
      lines.push(`    seeded${j} = true;`);
      lines.push(genStmts(k.init, '    ', o, env));
      lines.push(`  }`);
    }
    const params = Array.from({ length: k.inputWidth }, (_, i) => `a${i}`).join(', ');
    const declare = (init: (n: string, i: number) => string) => (inputs.length > 0 ? `let ${inputs.map(init).join(', ')};` : '');
    if (worklist) {
      const pop = `T${j} = q${j}.pop(); ${inputs.map((n, i) => `${n} = T${j}[${i}];`).join(' ')}`;
      lines.push(`  const q${j} = [];`);
      lines.push(`  function run${j}() {`);
      lines.push(`    if (q${j}.length === 0) return;`);
      lines.push(`    ${declare((n) => n)}`);
      lines.push(`    let ${pop}`);
      lines.push(`    for (;;) {`);
      lines.push(genStmts(k.body, '      ', o, env));
      lines.push(`      if (q${j}.length === 0) return;`);
      lines.push(`      ${pop}`);
      lines.push(`    }`);
      lines.push(`  }`);
      lines.push(`  function st${j}(${params}) { ${seed}q${j}.push([${params}]); run${j}(); }`);
    } else if (feeds) {
      lines.push(`  function st${j}(${params}) {`);
      if (seed) lines.push(`    ${seed.trim()}`);
      lines.push(`    ${declare((n, i) => `${n} = a${i}`)}`);
      lines.push(`    for (;;) {`);
      lines.push(genStmts(k.body, '      ', o, env));
      lines.push(`      return;`);
      lines.push(`    }`);
      lines.push(`  }`);
    } else {
      lines.push(`  function st${j}(${params}) {`);
      if (seed) lines.push(`    ${seed.trim()}`);
      lines.push(genStmts(k.body, '    ', o, env));
      lines.push(`  }`);
    }
    if (k.epilogue.length > 0) {
      lines.push(`  function fl${j}() {`);
      lines.push(genStmts(k.epilogue, '    ', o, env));
      lines.push(`  }`);
    }
    ends.push(`${seed}${worklist ? `run${j}(); ` : ''}${k.epilogue.length > 0 ? `fl${j}();` : ''}`.trim());
  });

  const w0 = stages[0].kernel.inputWidth;
  const pushArgs = Array.from({ length: w0 }, (_, i) => `t[${i}]`).join(', ');
  lines.push(`  return {`);
  lines.push(`    push(t) { st0(${pushArgs}); },`);
  lines.push(`    end() { ${ends.filter((e) => e !== '').join(' ')} },`);
  lines.push(`    setEmit(e) { EMIT = e; },`);
  lines.push(`  };`);
  lines.push(`})()`);
  return lines.filter((l) => l !== '').join('\n');
}

// The wasm backend takes a whole pipeline when every segment is a kernel run
// or a barrier it knows; otherwise each kernel run alone, with the rest in
// JS. Kernels with a prologue (seeds) stay in JS either way.
// Wasm modules are compiled once, when the registry is built (`wasmModules`
// collects their definitions); each pipeline instance then borrows an
// instance of one (rt.wasmPipeline).
function genWasm(segments: FusedSegment[], inputWidth: number, paramWidth: number, wasmModules: string[]): string {
  const w = compilePipeline(segments, inputWidth, paramWidth);
  const name = `W${wasmModules.length}`;
  const names = segments.map((s) => (s.k === 'kernels' ? s.stages.map((st) => st.name).join(' → ') : s.k)).join(' → ');
  wasmModules.push(`const ${name} = rt.wasmModule([${w.bytes.join(',')}]); // ${names}`);
  const layout = { outBase: w.outBase, outWidth: w.outputWidth, inBase: w.inBase, inWidth: w.inputWidth, inTokens: w.inTokens };
  return `rt.wasmPipeline(${name}, ${JSON.stringify(layout)}, P)`;
}

function genFused(p: FusedIR, o: CodegenOptions, wasmModules: string[]): string {
  if (o.target === 'wasm' && p.segments.every(inWasm)) {
    const w = inputWidthOf(p) ?? (() => { throw new Error(`'${p.name}': cannot tell its input width`); })();
    return `R[${JSON.stringify(p.name)}] = (P = []) => ${genWasm(p.segments, w, p.paramWidth, wasmModules)};`;
  }
  const segs = p.segments.map((s) => {
    if (s.k !== 'kernels') return `    ${genBuiltinStage(s, o)},`;
    if (o.target === 'wasm' && inWasm(s)) return `    ${genWasm([s], s.stages[0].kernel.inputWidth, p.paramWidth, wasmModules)},`;
    return `    ${genSegment(s.stages, o)},`;
  });
  return [
    `R[${JSON.stringify(p.name)}] = (P = []) => rt.pipeline([`,
    ...segs,
    `]);`,
  ].join('\n');
}

export function generate(mod: ModuleIR, opts: CodegenOptions = {}): string {
  const wasmModules: string[] = [];
  const defs = mod.processes.map((p) =>
    p.k === 'kernel' ? genKernel(p, opts) : p.k === 'fused' ? genFused(p, opts, wasmModules) : genPipeline(p, opts));
  return [
    `(rt) => {`,
    `const R = Object.create(null);`,
    // Processes the host supplies: a place for each, filled by rt.provide.
    ...mod.host.map((h) => `R[${JSON.stringify(h.name)}] = rt.hostProcess(R, ${JSON.stringify(h.name)});`),
    ...wasmModules,
    ...(opts.countOps ? [`let OPS = 0;`] : []),
    ...defs,
    // Factories also take their parameters by name (rt.nameParams).
    `rt.nameParams(R, ${JSON.stringify(mod.signatures)});`,
    // …and the token layouts of the program's named types (rt.tokenType).
    `rt.describeTypes(R, ${JSON.stringify(mod.types)});`,
    ...(opts.countOps ? [`rt.describeOps(R, () => OPS);`] : []),
    `return R;`,
    `}`,
  ].join('\n');
}
