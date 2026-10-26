// Elaboration: the program's structure → IR.
//
// What Nile *means* — values, broadcasting, lifting, user operators, guards,
// state, effects — is defined once, in semantics/nile.mooi; a kernel's IR is
// the residue of running that semantics on symbolic scalars
// (semantics/staged.ts). This module does the rest: types and signatures,
// sugar, pipelines and their ordering discipline, templates (process
// arguments inlined as closures) and families (mid-stream ⇒, substitute.ts).

import type * as A from './ast.js';
import type { HostProcess, KernelIR, ModuleIR, ParamSig, PipelineIR, ProcessIR, StageIR, TokenLayout } from './ir.js';
import { assembleFamily, plainKernel, SubstError, type Generator, type StagedKernel } from './substitute.js';
import { desugar, SugarError } from './semantics/sugar.js';
import { elabPipelineStages, type PipelineProgram } from './semantics/pipelines.js';
import { stageExpr, stageGenerator, stageKernel } from './semantics/staged.js';
import type { KernelContext, Program } from './semantics/domain.js';
import { ElabError, fieldInfo, fromSlots, paramEnv, paramWidth, REAL, realField, shapeWidth, tokenLayout, type ParamGroup, type Shape, type StreamSig } from './values.js';
import { opKey } from './ops.js';

// A user operator: its parameters' shapes, its result's, and its body.
interface OpEntry {
  params: { name: string; shape: Shape }[];
  result: Shape;
  body: A.Expr;
}

interface ElabResult {
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

// What a process definition is (kindOf); a pipeline definition carries its
// pipeline, so nobody looks for it twice.
type Classified =
  | { kind: 'template' | 'family' | 'generator' | 'kernel' }
  | { kind: 'pipeline'; body: A.PipelineElem[] };

// What compileKernels found: the processes, with what it could not compile
// and what it leaves to each use site.
interface Compiled {
  processes: ProcessIR[];
  unsupported: { name: string; reason: string }[];
  templates: string[];
}

// What elaboration reports as unsupported, rather than a bug.
const isElabError = (e: unknown): e is Error => e instanceof ElabError || e instanceof SubstError || e instanceof SugarError;

class Elaborator {

  private types = new Map<string, Shape>();
  private ops = new Map<string, OpEntry>();
  private streams = new Map<string, StreamSig | null>(); // null: not a plain stream
  private kernels = new Map<string, A.Kernel>();
  private host: HostProcess[] = []; // declared by signature, supplied by the host
  private hostParams = new Map<string, ParamGroup[]>(); // their parameters, for the signatures
  private generators = new Set<string>(); // no ∀: emit a finite sequence, then pass input through

  run(modules: A.Module[]): ElabResult {
    const decls = modules.flatMap((m) => m.decls);
    this.declare(decls);
    this.declareHostProcesses(decls);
    const { processes, unsupported, templates } = this.compileKernels(decls);
    const compiled = new Set([...processes.map((p) => p.name), ...this.host.map((h) => h.name)]);
    dropBrokenPipelines(processes, compiled, unsupported);
    // Every compiled process's parameters by name: the host's, and the
    // kernels' (a family compiles to more processes than it names; the root
    // alone is the host's to call).
    const signatures: Record<string, ParamSig[]> = {};
    for (const [n, groups] of this.hostParams) signatures[n] = paramSigs(groups);
    for (const [n, d] of this.kernels) if (compiled.has(n)) signatures[n] = paramSigs(this.paramGroups(d));
    const ir: ModuleIR = { processes: processes.filter((p) => compiled.has(p.name)), host: this.host, signatures, types: this.tokenLayouts() };
    return { ir, unsupported, templates };
  }

  contexts(modules: A.Module[], all = false) {
    this.declare(modules.flatMap((m) => m.decls));
    const program = this.program;
    const kernels = new Map<string, KernelContext>();
    for (const [name, d] of this.kernels) {
      const sig = this.streamSig(d.type);
      const { kind } = this.kindOf(d);
      if (!sig || !(kind === 'kernel' || (all && (kind === 'family' || kind === 'generator')))) continue;
      try {
        kernels.set(name, { kernel: desugar(d, this.fieldNames).kernel, params: this.paramGroups(d), sig });
      } catch (e) {
        if (!isElabError(e)) throw e; // unsupported here: skipped
      }
    }
    return { program, kernels };
  }

  // --- the two passes ---

  // Pass 1: types, operators, and process signatures, so later definitions
  // can reference anything regardless of order. Types first: signatures
  // name them.
  private declare(decls: A.TopLevel[]): void {
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
  }

  // A process type with parameters is a process the host supplies: its
  // signature is all Nile knows. It takes its parameters by name like any
  // other, and the generated code holds a place for it (rt.provide).
  private declareHostProcesses(decls: A.TopLevel[]): void {
    for (const d of decls) {
      if (d.kind !== 'processTypeDef' || !d.params) continue;
      const sig = this.plainSig(d);
      const groups = d.params.map((g) => ({ names: g.names, shape: this.resolveType(g.type) }));
      this.hostParams.set(d.name, groups);
      this.host.push({ name: d.name, paramWidth: paramWidth(groups), inputWidth: shapeWidth(sig.input), outputWidth: shapeWidth(sig.output) });
    }
  }

  // Pass 2: kernels and pipelines. Elaboration is honest about its coverage:
  // a kernel it cannot handle is listed as unsupported, with the reason.
  private compileKernels(decls: A.TopLevel[]): Compiled {
    const processes: ProcessIR[] = [];
    const unsupported: { name: string; reason: string }[] = [];
    const templates: string[] = [];
    for (const d of decls) {
      if (d.kind !== 'kernel') continue;
      const c = this.kindOf(d);
      if (c.kind === 'template') {
        templates.push(d.name);
        continue;
      }
      try {
        processes.push(...(
          c.kind === 'family' ? this.elabFamily(d)
          : c.kind === 'pipeline' ? [this.elabPipeline(d, c.body, this.plainSig(d))]
          : [plainKernel(this.elabKernel(d, this.plainSig(d)))]));
      } catch (e) {
        if (!isElabError(e)) throw e;
        unsupported.push({ name: d.name, reason: e.message });
      }
    }
    return { processes, unsupported, templates };
  }

  // Every named record type's layout, for the host.
  private tokenLayouts(): Record<string, TokenLayout> {
    const types: Record<string, TokenLayout> = {};
    for (const [name, shape] of this.types) if (shape.k === 'record') types[name] = tokenLayout(shape);
    return types;
  }

  // --- types, signatures, operators ---

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

  // The field names of a record type, for sugar's patterns.
  private fieldNames = (t: A.Type): string[] => {
    const shape = this.resolveType(t);
    return shape.k === 'record' ? shape.fields.map((f) => f.name ?? '') : [];
  };

  // The stream signature of a kernel/process type, or null when it is not a
  // plain stream (we don't elaborate those yet).
  private streamSig(t: A.KernelType): StreamSig | null {
    if (t.kind === 'streamType') {
      return { input: this.resolveType(t.input), output: this.resolveType(t.output) };
    }
    return this.streams.get(t.name) ?? null;
  }

  // The signature a process must have to be elaborated.
  private plainSig(d: { name: string; type: A.KernelType }): StreamSig {
    const sig = this.streamSig(d.type);
    if (!sig) throw new ElabError(`'${d.name}' does not have a plain stream type`);
    return sig;
  }

  // A process type names a process: the parameter that makes a template.
  private isProcessType(t: A.Type): t is A.Type & { kind: 'namedType' } {
    return t.kind === 'namedType' && this.streams.has(t.name);
  }

  private isTemplate(k: A.Kernel): boolean {
    return (k.params ?? []).some((g) => this.isProcessType(g.type));
  }

  // What a process definition is, from its shape. A template takes a
  // process-typed parameter and is instantiated where it is used; a pipeline
  // definition's whole body is `⇒ …`; a family has a `⇒` anywhere else, so
  // it is compiled with everything it can become; a generator has no ∀ and
  // no flush body, emitting a finite sequence before passing input through;
  // a kernel is the rest. The interpreter handles kernels, and families and
  // generators only when asked; the compiler handles all but templates.
  private kindOf(d: A.Kernel): Classified {
    const body = pipelineBody(d);
    return this.isTemplate(d) ? { kind: 'template' }
      : body ? { kind: 'pipeline', body }
      : hasForward(kernelStmts(d)) ? { kind: 'family' }
      : this.generators.has(d.name) ? { kind: 'generator' }
      : { kind: 'kernel' };
  }

  private paramShape(t: A.Type, processName: string): Shape {
    if (this.isProcessType(t)) {
      throw new ElabError(`'${processName}' takes a process-typed parameter ('${t.name}'); higher-order processes are not yet supported`);
    }
    return this.resolveType(t);
  }

  // A kernel's parameters, by group, with their shapes.
  private paramGroups(d: A.Kernel): ParamGroup[] {
    return (d.params ?? []).map((g) => ({ names: g.names, shape: this.paramShape(g.type, d.name) }));
  }

  private addOp(d: A.OpDef): void {
    this.ops.set(opKey(d.fixity, d.op, d.closeOp), {
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
        return k && this.paramGroups(k).flatMap((g) => g.names.map(() => g.shape));
      },
    };
  }

  // A kernel, staged: with ⇒ statements still in it if it has any (a
  // family's member); plainKernel checks there are none.
  private elabKernel(source: A.Kernel, sig: StreamSig): StagedKernel {
    // Scans and windows are sugar (sugar.ts); what they declared is kept as
    // `access` metadata for parallel backends.
    const { kernel: d, declared } = desugar(source, this.fieldNames);
    const key = (name: string, what: string) => realField(sig.input, name, what);
    const access: KernelIR['access'] =
      declared.scan ? { scan: { ...declared.scan, key: key(declared.scan.key, 'scan key') } }
      : declared.window ? { window: { key: declared.window.key === null ? null : key(declared.window.key, 'window segment key') } }
      : undefined;
    // The kernel is the residue of staging its semantics (semantics/).
    return stageKernel(this.program, { kernel: d, params: this.paramGroups(d), sig }, access);
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

  // A generator's body for the frame interpreter: params live in the frame
  // (input slots 1…), prologue declarations are plain locals.
  private elabGenerator(d: A.Kernel): Generator {
    return stageGenerator(this.program, { kernel: d, params: this.paramGroups(d), sig: this.plainSig(d) });
  }

  // Everything `d` can substitute into, transitively: stream processes it may
  // become (members) and generators it may invoke.
  private elabFamily(d: A.Kernel): (KernelIR | PipelineIR)[] {
    const sig = this.plainSig(d);
    const members: StagedKernel[] = [];
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
      for (const t of forwardTargets(kernelStmts(k))) visit(t);
    };
    visit(d.name);
    return assembleFamily({
      root: d.name,
      paramWidth: paramWidth(this.paramGroups(d)),
      inputWidth: shapeWidth(sig.input),
      outputWidth: shapeWidth(sig.output),
      members, generators,
    });
  }

  // --- pipelines ---

  private elabPipeline(d: A.Kernel, elems: A.PipelineElem[], sig: StreamSig): PipelineIR {
    const params = paramEnv(this.paramGroups(d), (shape, at) => fromSlots(shape, 'param', at));
    const { stages } = elabPipelineStages(this.pipelineProgram, d.name, elems, params.env, new Map(), sig.input);
    return { k: 'pipeline', name: d.name, paramWidth: params.width, stages };
  }

  // What the pipeline semantics (semantics/pipelines.mooi) asks of the program.
  //
  // Templates are processes with process-typed parameters. A process
  // argument is always written out where the pipeline is built, so it is a
  // closure — the argument's pipeline plus the caller's scope — and a use of
  // the parameter splices that pipeline in. No process values exist at run
  // time.
  private get pipelineProgram(): PipelineProgram {
    return {
      field: (shape, name) => fieldInfo(shape, name),
      realField,
      expr: (e, env) => stageExpr(this.program, e, env),
      type: (t) => this.resolveType(t),
      stream: (name) => this.streams.get(name) ?? null,
      known: (name) => this.streams.has(name),
      template: (name) => {
        const k = this.kernels.get(name);
        return k && this.isTemplate(k) ? { name: k.name, params: k.params ?? [], pipeline: pipelineBody(k) } : null;
      },
      isStream: (t) => this.isProcessType(t),
    };
  }
}

// Parameters by name, in order, with their flattened widths.
const paramSigs = (groups: ParamGroup[]): ParamSig[] =>
  groups.flatMap((g) => g.names.map((name) => ({ name, width: shapeWidth(g.shape) })));

// A pipeline is only as good as its stages: anything that names a process
// that did not compile is unsupported too (transitively), rather than
// compiling to a reference that fails at run time. Removes from `compiled`.
function dropBrokenPipelines(processes: ProcessIR[], compiled: Set<string>, unsupported: { name: string; reason: string }[]): void {
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
}

function stageNames(stages: StageIR[]): string[] {
  return stages.flatMap((s) =>
    s.k === 'stage' ? [s.name] : s.k === 'dupCat' || s.k === 'dupZip' ? s.branches.flatMap(stageNames) : []);
}

// A body that is just `⇒ pipeline` is a pipeline definition: that pipeline.
function pipelineBody(d: A.Kernel): A.PipelineElem[] | null {
  const p = d.prologue[0];
  return d.forAlls.length === 0 && d.epilogue.length === 0 && d.prologue.length === 1 && p.kind === 'forward' ? p.pipeline : null;
}
// Every statement of a process, in order: prologue, each ∀ body, flush body.
const kernelStmts = (d: A.Kernel): A.Stmt[] => [...d.prologue, ...d.forAlls.flatMap((f) => f.body), ...d.epilogue];
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

