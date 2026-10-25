// Elaboration: the program's structure → IR.
//
// What Nile *means* — values, broadcasting, lifting, user operators, guards,
// state, effects — is defined once, in semantics/nile.mooi; a kernel's IR is
// the residue of running that semantics on symbolic scalars
// (semantics/staged.ts). This module does the rest: types and signatures,
// sugar, pipelines and their ordering discipline, templates (process
// arguments inlined as closures) and families (mid-stream ⇒, substitute.ts).

import type * as A from './ast.js';
import type { HostProcess, KernelIR, ModuleIR, ParamSig, PipelineIR, ProcessIR, ScalarExpr, StageIR, TokenLayout } from './ir.js';
import { assembleFamily, SubstError, type Generator } from './substitute.js';
import { desugar, SugarError } from './semantics/sugar.js';
import { elabPipelineStages, type PipelineProgram } from './semantics/pipelines.js';
import { stageExpr, stageGenerator, stageKernel } from './semantics/staged.js';
import type { Program } from './semantics/domain.js';
import { ElabError, fieldInfo, fit, fromSlots, REAL, scalar, shapeWidth, tokenLayout, type Shape, type Value } from './values.js';

// --- operator tables -----------------------------------------------------------

interface OpEntry {
  params: { name: string; shape: Shape }[];
  result: Shape;
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
  private host: HostProcess[] = []; // declared by signature, supplied by the host
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
    // A process type with parameters is a process the host supplies: its
    // signature is all Nile knows. It takes its parameters by name like any
    // other, and the generated code holds a place for it (rt.provide).
    for (const d of decls) {
      if (d.kind !== 'processTypeDef' || !d.params) continue;
      const sig = this.streamSig(d.type);
      if (!sig) throw new ElabError(`'${d.name}' does not have a plain stream type`);
      signatures[d.name] = d.params.flatMap((g) => g.names.map((name) => ({ name, width: shapeWidth(this.resolveType(g.type)) })));
      this.host.push({ name: d.name, paramWidth: signatures[d.name].reduce((n, p) => n + p.width, 0), inputWidth: shapeWidth(sig.input), outputWidth: shapeWidth(sig.output) });
    }
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
    const compiled = new Set([...processes.map((p) => p.name), ...this.host.map((h) => h.name)]);
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
    return { ir: { processes: processes.filter((p) => compiled.has(p.name)), host: this.host, signatures, types }, unsupported, templates };
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
      result: this.resolveType(d.resultType),
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
    const { stages } = elabPipelineStages(this.pipelineProgram, d.name, elems, env, new Map(), sig.input);
    return { k: 'pipeline', name: d.name, paramWidth, stages };
  }

  // What the pipeline semantics (semantics/pipelines.mooi) asks of the program.
  private get pipelineProgram(): PipelineProgram {
    return {
      field: (shape, name) => fieldInfo(shape, name),
      expr: (e, env) => stageExpr(this.program, e, env),
      fit,
      type: (t) => this.resolveType(t),
      local: (name) => scalar({ k: 'local', name }),
      stream: (name) => this.streams.get(name) ?? null,
      known: (name) => this.streams.has(name),
      template: (name) => {
        const k = this.kernels.get(name);
        return k && this.isTemplate(k) ? k : null;
      },
      isStream: (t) => t.kind === 'namedType' && this.streams.has(t.name),
    };
  }

  // --- templates: process-typed parameters ---
  //
  // A process argument is always written out where the pipeline is built, so
  // it is a closure — the argument's pipeline plus the caller's scope — and
  // a use of the parameter splices that pipeline in. No process values exist
  // at run time.

  private isTemplate(k: A.Kernel): boolean {
    return (k.params ?? []).some((g) => g.type.kind === 'namedType' && this.streams.has(g.type.name));
  }

}


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

