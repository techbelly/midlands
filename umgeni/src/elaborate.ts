// Elaboration: the program's structure → IR.
//
// What Nile *means* — values, broadcasting, lifting, user operators, guards,
// state, effects — is defined once, in semantics/nile.mooi; a kernel's IR is
// the residue of running that semantics on symbolic scalars
// (semantics/staged.ts). This module does the rest: types and signatures,
// sugar, pipelines and their ordering discipline, templates (process
// arguments inlined as closures) and families (mid-stream ⇒, substitute.ts).

import type * as A from './ast.js';
import type { KernelIR, ModuleIR, ParamSig, PipelineIR, ProcessIR, ScalarExpr, StageIR, TokenLayout } from './ir.js';
import { assembleFamily, SubstError, type Generator } from './substitute.js';
import { desugar, SugarError } from './semantics/sugar.js';
import { stageExpr, stageGenerator, stageKernel } from './semantics/staged.js';
import type { Program } from './semantics/domain.js';
import { ElabError, fieldInfo, fit, flatten, fromSlots, REAL, scalar, shapeWidth, tokenLayout, type Shape, type Value } from './values.js';

// --- operator tables -----------------------------------------------------------

// Operators known commutative: a ReduceBy using only these needs no stable
// grouping (within-group arrival order cannot affect the result).
const KNOWN_COMMUTATIVE = new Set(['+', '×', '◁', '▷', '∧', '∨']);

interface OpEntry {
  params: { name: string; shape: Shape }[];
  body: A.Expr;
}

// --- the elaborator ------------------------------------------------------------

type Env = Map<string, Value>;

interface StreamSig {
  input: Shape;
  output: Shape;
}

export interface ElabResult {
  ir: ModuleIR;
  // Processes that could not be elaborated (constructs beyond the current
  // subset), with the reason. Elaboration is honest about its coverage.
  unsupported: { name: string; reason: string }[];
  // Processes with process-typed parameters (a Texture, a Compositor…).
  // Not compiled on their own: each use site instantiates one inline.
  templates: string[];
}

// For the interpreter (semantics/concrete.ts): each kernel's desugared
// AST, parameters and stream types, with the program's types and operators.
// `all`: include families and generators (for an interpreter of ⇒).
export function kernelContexts(modules: A.Module[], all = false) {
  return new Elaborator().contexts(modules, all);
}

export function elaborateProgram(modules: A.Module[]): ElabResult {
  return new Elaborator().run(modules);
}

class Elaborator {

  private types = new Map<string, Shape>();
  private ops = new Map<string, OpEntry>();
  private streams = new Map<string, StreamSig | null>(); // null: not a plain stream
  private kernels = new Map<string, A.Kernel>();
  private generators = new Set<string>(); // no ∀: emit a finite sequence, then pass input through

  run(modules: A.Module[]): ElabResult {
    const decls = modules.flatMap((m) => m.decls);
    // Pass 1: types, operators, and process signatures, so later definitions
    // can reference anything regardless of order. Types first: signatures
    // name them.
    for (const d of decls) if (d.kind === 'typeDef') this.types.set(d.name, this.resolveType(d.type, d.name));
    for (const d of decls) {
      if (d.kind === 'typeDef') continue;
      else if (d.kind === 'opDef') this.addOp(d);
      else if (d.kind === 'processTypeDef') this.streams.set(d.name, this.streamSig(d.type));
      else if (d.kind === 'kernel') {
        this.streams.set(d.name, this.streamSig(d.type));
        this.kernels.set(d.name, d);
      }
    }
    this.classifyGenerators();
    // Pass 2: kernels and pipelines.
    const processes: ProcessIR[] = [];
    const signatures: Record<string, ParamSig[]> = {};
    const unsupported: { name: string; reason: string }[] = [];
    const templates: string[] = [];
    for (const d of decls) {
      if (d.kind !== 'kernel') continue;
      if (this.isTemplate(d)) {
        templates.push(d.name);
        continue;
      }
      try {
        processes.push(...(usesSubstitution(d) ? this.elabFamily(d) : [this.elabProcess(d)]));
        signatures[d.name] = (d.params ?? []).flatMap((g) => {
          const width = shapeWidth(this.paramShape(g.type, d.name));
          return g.names.map((name) => ({ name, width }));
        });
      } catch (e) {
        if (e instanceof ElabError || e instanceof SubstError || e instanceof SugarError) {
          unsupported.push({ name: d.name, reason: e.message });
        }
        else throw e;
      }
    }
    // A pipeline is only as good as its stages: anything that names a
    // process that did not compile is unsupported too (transitively), rather
    // than compiling to a reference that fails at run time.
    const compiled = new Set(processes.map((p) => p.name));
    for (let changed = true; changed;) {
      changed = false;
      for (const p of processes) {
        if (p.k !== 'pipeline' || !compiled.has(p.name)) continue;
        const missing = stageNames(p.stages).find((n) => !compiled.has(n));
        if (missing === undefined) continue;
        compiled.delete(p.name);
        unsupported.push({ name: p.name, reason: `uses '${missing}', which did not compile` });
        changed = true;
      }
    }
    for (const name of Object.keys(signatures)) if (!compiled.has(name)) delete signatures[name];
    const types: Record<string, TokenLayout> = {};
    for (const [name, shape] of this.types) if (shape.k === 'record') types[name] = tokenLayout(shape);
    return { ir: { processes: processes.filter((p) => compiled.has(p.name)), signatures, types }, unsupported, templates };
  }

  contexts(modules: A.Module[], all = false) {
    this.run(modules); // pass 1 tables (and validation)
    const program = this.program;
    const kernels = new Map<string, { kernel: A.Kernel; params: { names: string[]; shape: Shape }[]; sig: StreamSig }>();
    for (const [name, d] of this.kernels) {
      const sig = this.streamSig(d.type);
      if (!sig || this.isTemplate(d) || (!all && (usesSubstitution(d) || this.generators.has(name)))) continue;
      if (d.forAlls.length === 0 && d.prologue.length === 1 && d.prologue[0].kind === 'forward') continue; // a pipeline
      try {
        const { kernel } = desugar(d, (t) => {
          const shape = this.resolveType(t);
          return shape.k === 'record' ? shape.fields.map((f) => f.name ?? '') : [];
        });
        kernels.set(name, { kernel, params: (d.params ?? []).map((g) => ({ names: g.names, shape: this.paramShape(g.type, name) })), sig });
      } catch {
        // unsupported here; skipped
      }
    }
    return { program, kernels };
  }

  private resolveType(t: A.Type, name: string | null = null): Shape {
    switch (t.kind) {
      case 'namedType': {
        if (t.name === 'Real') return REAL;
        const found = this.types.get(t.name);
        if (!found) throw new ElabError(`unknown type '${t.name}'`);
        return found;
      }
      case 'tupleType':
        return {
          k: 'record', name,
          fields: t.elements.map((e) => ({ name: null, shape: this.resolveType(e) })),
        };
      case 'recordType':
        return {
          k: 'record', name,
          fields: t.fields.flatMap((g) => {
            const shape = this.resolveType(g.type);
            return g.names.map((n) => ({ name: n, shape }));
          }),
        };
    }
  }

  // The stream signature of a kernel/process type, or null when it is not a
  // plain stream (we don't elaborate those yet).
  private streamSig(t: A.KernelType): StreamSig | null {
    if (t.kind === 'streamType') {
      return { input: this.resolveType(t.input), output: this.resolveType(t.output) };
    }
    return this.streams.get(t.name) ?? null;
  }

  private addOp(d: A.OpDef): void {
    const key =
      d.fixity === 'infix' ? d.op
      : d.fixity === 'prefix' ? `${d.op}_`
      : `${d.op}_${d.closeOp}`;
    this.ops.set(key, {
      params: d.params.map((p) => ({ name: p.name, shape: this.resolveType(p.type) })),
      body: d.body,
    });
  }

  // --- processes ---

  // What the semantics (semantics/) needs to know about the program.
  private get program(): Program {
    return {
      type: (t) => this.resolveType(t),
      op: (key) => this.ops.get(key),
      params: (name) => {
        const k = this.kernels.get(name);
        return k && (k.params ?? []).flatMap((g) => g.names.map(() => this.paramShape(g.type, name)));
      },
    };
  }

  // A pure expression (pipeline and template arguments), staged.
  private expr(e: A.Expr, env: Env): Value {
    return stageExpr(this.program, e, env);
  }

  private elabProcess(d: A.Kernel): ProcessIR {
    const sig = this.streamSig(d.type);
    if (!sig) throw new ElabError(`'${d.name}' does not have a plain stream type`);

    // Parameters -> flattened slots.
    const { env, width: paramWidth } = this.paramEnv(d, 'param', 0);

    // A body that is just `⇒ pipeline` is a pipeline definition.
    if (
      d.forAlls.length === 0 && d.epilogue.length === 0 &&
      d.prologue.length === 1 && d.prologue[0].kind === 'forward'
    ) {
      return this.elabPipeline(d, d.prologue[0].pipeline, env, paramWidth, sig);
    }

    return this.elabKernel(d, sig);
  }

  private paramShape(t: A.Type, processName: string): Shape {
    if (t.kind === 'namedType' && this.streams.has(t.name)) {
      throw new ElabError(`'${processName}' takes a process-typed parameter ('${t.name}'); higher-order processes are not yet supported`);
    }
    return this.resolveType(t);
  }

  private elabKernel(source: A.Kernel, sig: StreamSig): KernelIR {
    // Scans and windows are sugar (sugar.ts); what they declared is kept as
    // `access` metadata for parallel backends.
    const { kernel: d, declared } = desugar(source, (t) => {
      const shape = this.resolveType(t);
      return shape.k === 'record' ? shape.fields.map((f) => f.name ?? '') : [];
    });
    const realField = (name: string, what: string) => {
      const f = fieldInfo(sig.input, name);
      if (f.shape.k !== 'real') throw new ElabError(`${what} '@${name}' must be a Real field`);
      return f.offset;
    };
    const access: KernelIR['access'] =
      declared.scan ? { scan: { ...declared.scan, key: realField(declared.scan.key, 'scan key') } }
      : declared.window ? { window: { key: declared.window.key === null ? null : realField(declared.window.key, 'window segment key') } }
      : undefined;
    // The kernel is the residue of staging its semantics (semantics/).
    const params = (d.params ?? []).map((g) => ({ names: g.names, shape: this.paramShape(g.type, d.name) }));
    return stageKernel(this.program, d, params, sig, access);
  }

  // --- substitution (`⇒` mid-stream; see substitute.ts) ---

  // Generators: no ∀ and no flush body, substituting only into generators.
  // Greatest fixpoint, so mutually recursive generators qualify.
  private classifyGenerators(): void {
    for (const [name, d] of this.kernels) {
      if (d.forAlls.length === 0 && d.epilogue.length === 0) this.generators.add(name);
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const name of this.generators) {
        if (forwardTargets(this.kernels.get(name)!.prologue).some((t) => !this.generators.has(t))) {
          this.generators.delete(name);
          changed = true;
        }
      }
    }
  }

  private paramEnv(d: A.Kernel, kind: 'param' | 'input', base: number): { env: Env; width: number } {
    const env: Env = new Map();
    let width = 0;
    for (const group of d.params ?? []) {
      const shape = this.paramShape(group.type, d.name);
      for (const name of group.names) {
        env.set(name, fromSlots(shape, kind, base + width));
        width += shapeWidth(shape);
      }
    }
    return { env, width };
  }

  // A generator's body for the frame interpreter: params live in the frame
  // (input slots 1…), prologue declarations are plain locals.
  private elabGenerator(d: A.Kernel): Generator {
    const sig = this.streamSig(d.type);
    if (!sig) throw new ElabError(`'${d.name}' does not have a plain stream type`);
    const params = (d.params ?? []).map((g) => ({ names: g.names, shape: this.paramShape(g.type, d.name) }));
    return stageGenerator(this.program, d, params, sig);
  }

  // Everything `d` can substitute into, transitively: stream processes it may
  // become (members) and generators it may invoke.
  private elabFamily(d: A.Kernel): (KernelIR | PipelineIR)[] {
    const sig = this.streamSig(d.type);
    if (!sig) throw new ElabError(`'${d.name}' does not have a plain stream type`);
    const members: KernelIR[] = [];
    const generators: Generator[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const k = this.kernels.get(name)!;
      const ksig = this.streamSig(k.type);
      if (!ksig || shapeWidth(ksig.input) !== shapeWidth(sig.input) || shapeWidth(ksig.output) !== shapeWidth(sig.output)) {
        throw new ElabError(`'${name}' cannot stand in for '${d.name}': stream types differ`);
      }
      if (this.generators.has(name)) {
        generators.push(this.elabGenerator(k));
      } else {
        members.push(this.elabKernel(k, ksig));
      }
      for (const t of forwardTargets([...k.prologue, ...k.forAlls.flatMap((f) => f.body), ...k.epilogue])) visit(t);
    };
    visit(d.name);
    return assembleFamily({
      root: d.name,
      paramWidth: this.paramEnv(d, 'param', 0).width,
      inputWidth: shapeWidth(sig.input),
      outputWidth: shapeWidth(sig.output),
      members, generators,
    });
  }

  // --- pipelines ---

  private elabPipeline(
    d: A.Kernel,
    elems: A.PipelineElem[],
    env: Env,
    paramWidth: number,
    sig: StreamSig,
  ): PipelineIR {
    const { stages } = this.elabStages(d, elems, env, sig.input);
    return { k: 'pipeline', name: d.name, paramWidth, stages };
  }

  // A pipeline's stages over an input stream shape; returns the output shape.
  // --- templates: process-typed parameters ---
  //
  // A process argument is always written out where the pipeline is built, so
  // it is a closure — the argument's pipeline plus the caller's scope — and
  // a use of the parameter splices that pipeline in. No process values exist
  // at run time.

  private isTemplate(k: A.Kernel): boolean {
    return (k.params ?? []).some((g) => g.type.kind === 'namedType' && this.streams.has(g.type.name));
  }

  private pipelineOf(a: A.KernelArg, where: string): A.PipelineElem[] {
    if ('kind' in a && a.kind === 'pipelineArg') return a.elements;
    if ('kind' in a && a.kind === 'kernelApp') return [a];
    if ('kind' in a && (a.kind as string) === 'identityPipeline') return [a as unknown as A.IdentityPipeline];
    if ('kind' in a && a.kind === 'var') return [{ kind: 'kernelRef', name: a.name }];
    throw new ElabError(`${where} expects a process here`);
  }

  private instantiate(k: A.Kernel, args: A.KernelArg[], env: Env, procs: ProcEnv, input: Shape): { stages: StageIR[]; output: Shape } {
    const body = k.prologue[0];
    if (k.forAlls.length > 0 || k.prologue.length !== 1 || body.kind !== 'forward') {
      throw new ElabError(`'${k.name}' takes a process parameter, so it must be a pipeline definition (⇒ …)`);
    }
    const calleeEnv: Env = new Map();
    const calleeProcs: ProcEnv = new Map();
    const names = (k.params ?? []).flatMap((g) => g.names.map((n) => ({ n, type: g.type })));
    if (args.length !== names.length) throw new ElabError(`'${k.name}' takes ${names.length} arguments, given ${args.length}`);
    names.forEach(({ n, type }, i) => {
      if (type.kind === 'namedType' && this.streams.has(type.name)) {
        calleeProcs.set(n, { elems: this.pipelineOf(args[i], `'${k.name}'`), env, procs });
      } else {
        const v = fit(this.expr(args[i] as A.Expr, env), this.resolveType(type));
        if (!v) throw new ElabError(`argument '${n}' of '${k.name}' does not fit its parameter`);
        calleeEnv.set(n, v);
      }
    });
    return this.elabStages(k, body.pipeline, calleeEnv, input, calleeProcs);
  }

  private elabStages(
    d: A.Kernel, elems: A.PipelineElem[], env: Env, input: Shape, procs: ProcEnv = new Map(),
  ): { stages: StageIR[]; output: Shape } {
    let stream = input;
    const stages: StageIR[] = [];
    // Ordering discipline: after a plain GroupBy, within-group arrival order
    // is unspecified, so only order-insensitive consumers may follow until a
    // ReduceBy makes keys unique (which restores determinism).
    let unorderedGroups = false;
    const requireOrder = (name: string) => {
      if (unorderedGroups) {
        throw new ElabError(
          `'${name}' in '${d.name}' consumes tokens in arrival order after a non-stable GroupBy; ` +
          `use 'GroupBy stable (…)' or reduce the groups first`,
        );
      }
    };
    for (const el of elems) {
      if (el.kind === 'identityPipeline') {
        stages.push({ k: 'identity' });
        continue;
      }
      if (el.kind === 'groupBy') {
        const keyIndexes = el.keys.map((k) => {
          const f = fieldInfo(stream, k);
          if (f.shape.k !== 'real') throw new ElabError(`GroupBy key '@${k}' must be a Real field`);
          return f.offset;
        });
        stages.push({ k: 'groupBy', keyIndexes, stable: el.stable });
        unorderedGroups = !el.stable;
        continue;
      }
      if (el.kind === 'reduceBy') {
        const keyIndexes = el.keys.map((k) => fieldInfo(stream, k).offset);
        const fields = el.fields.map((f) => {
          if (unorderedGroups && !KNOWN_COMMUTATIVE.has(f.op)) {
            throw new ElabError(
              `ReduceBy in '${d.name}' uses '${f.op}', not known to be commutative, on unordered groups; ` +
              `use 'GroupBy stable (…)'`,
            );
          }
          const scope: Env = new Map([
            ['#ra', scalar({ k: 'local', name: '#ra' })],
            ['#rb', scalar({ k: 'local', name: '#rb' })],
          ]);
          const op = this.expr(
            { kind: 'binOp', op: f.op, left: { kind: 'var', name: '#ra' }, right: { kind: 'var', name: '#rb' } }, scope);
          if (op.k !== 'scalar') throw new ElabError(`ReduceBy operator '${f.op}' must combine Reals`);
          const info = fieldInfo(stream, f.name);
          if (info.shape.k !== 'real') throw new ElabError(`ReduceBy field '${f.name}' must be a Real field`);
          return { index: info.offset, op: op.expr };
        });
        stages.push({ k: 'reduceBy', width: shapeWidth(stream), keyIndexes, fields });
        unorderedGroups = false; // keys are unique now; order is determined
        continue;
      }
      const { name } = el;
      if (name === 'SortBy') {
        if (el.kind !== 'kernelApp' || el.args.length !== 1) {
          throw new ElabError(`SortBy in '${d.name}' expects a single @field key`);
        }
        const key = el.args[0];
        if (typeof key !== 'object' || !('kind' in key) || key.kind !== 'offset') {
          throw new ElabError(`SortBy in '${d.name}' expects an @field key`);
        }
        stages.push({ k: 'sortBy', keyIndexes: [fieldInfo(stream, key.field).offset] });
        continue;
      }
      if (name === 'Reverse') {
        requireOrder(name);
        stages.push({ k: 'reverse' });
        continue;
      }
      if (name === 'DupCat' || name === 'DupZip') {
        requireOrder(name);
        const args = el.kind === 'kernelApp' ? el.args : [];
        const branches = args.map((a) => this.elabStages(d, this.pipelineOf(a, name), env, stream, procs));
        if (branches.length !== 2) throw new ElabError(`${name} in '${d.name}' takes two pipelines`);
        const pair: [StageIR[], StageIR[]] = [branches[0].stages, branches[1].stages];
        if (name === 'DupCat') {
          if (shapeWidth(branches[0].output) !== shapeWidth(branches[1].output)) {
            throw new ElabError(`DupCat in '${d.name}' takes two pipelines with the same output type`);
          }
          stages.push({ k: 'dupCat', branches: pair });
          stream = branches[0].output;
        } else {
          // DupZip pairs the branches' outputs: (β, γ).
          stages.push({ k: 'dupZip', branches: pair });
          stream = { k: 'record', name: null, fields: branches.map((b) => ({ name: null, shape: b.output })) };
        }
        continue;
      }
      // A process parameter: splice in the caller's pipeline, in its scope.
      const closure = procs.get(name);
      if (closure) {
        if (el.kind === 'kernelApp' && el.args.length > 0) throw new ElabError(`process parameter '${name}' takes no arguments`);
        requireOrder(name);
        const sub = this.elabStages(d, closure.elems, closure.env, stream, closure.procs);
        stages.push(...sub.stages);
        stream = sub.output;
        continue;
      }
      const template = this.kernels.get(name);
      if (template && this.isTemplate(template)) {
        requireOrder(name);
        const sub = this.instantiate(template, el.kind === 'kernelApp' ? el.args : [], env, procs, stream);
        stages.push(...sub.stages);
        stream = sub.output;
        continue;
      }
      const stageSig = this.streams.get(name);
      if (stageSig === undefined) throw new ElabError(`pipeline '${d.name}' references unknown process '${name}'`);
      if (stageSig === null) throw new ElabError(`pipeline stage '${name}' is not a plain stream`);
      requireOrder(name);
      const args: ScalarExpr[][] = [];
      if (el.kind === 'kernelApp') {
        for (const a of el.args) {
          if ('kind' in a && (a.kind === 'pipelineArg' || a.kind === 'kernelApp')) {
            throw new ElabError(`'${d.name}' passes a pipeline to '${name}'; higher-order arguments are not yet supported`);
          }
          args.push(flatten(this.expr(a as A.Expr, env)));
        }
      }
      stages.push({ k: 'stage', name, args });
      stream = stageSig.output;
    }
    return { stages, output: stream };
  }
}

interface Closure {
  elems: A.PipelineElem[];
  env: Env;
  procs: ProcEnv;
}
type ProcEnv = Map<string, Closure>;

function stageNames(stages: StageIR[]): string[] {
  return stages.flatMap((s) =>
    s.k === 'stage' ? [s.name] : s.k === 'dupCat' || s.k === 'dupZip' ? s.branches.flatMap(stageNames) : []);
}

// A `⇒` anywhere but as the whole body (the pipeline-definition form).
function usesSubstitution(d: A.Kernel): boolean {
  const isPipelineDef = d.forAlls.length === 0 && d.epilogue.length === 0
    && d.prologue.length === 1 && d.prologue[0].kind === 'forward';
  return !isPipelineDef && [d.prologue, ...d.forAlls.map((f) => f.body), d.epilogue].some(hasForward);
}
// Every statement, including those nested in if branches.
function* allStmts(list: A.Stmt[]): IterableIterator<A.Stmt> {
  for (const s of list) {
    yield s;
    if (s.kind === 'if') {
      yield* allStmts(s.then);
      yield* allStmts(s.else ?? []);
    }
  }
}
const hasForward = (stmts: A.Stmt[]) => [...allStmts(stmts)].some((s) => s.kind === 'forward');
// The process names a statement list substitutes into.
const forwardTargets = (stmts: A.Stmt[]): string[] =>
  [...allStmts(stmts)].flatMap((s) => (s.kind === 'forward' ? s.pipeline : []))
    .flatMap((e) => (e.kind === 'kernelApp' || e.kind === 'kernelRef' ? [e.name] : []));

