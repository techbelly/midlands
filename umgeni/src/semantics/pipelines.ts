// A pipeline's meaning: pipelines.mooi (with values.mooi for the argument
// values), bound to the program. The stages
// come out as IR; the discipline (what may follow an unordered GroupBy,
// what a template's arguments must be) is the equations'.

import type * as A from '../ast.js';
import type { StageIR } from '../ir.js';
import { ElabError, REAL, type Shape, type Stream, type Value } from '../values.js';
import { load } from '../../../mooi/src/mooi.js';
import { prelude } from '../../../mooi/src/prelude.js';
import { pipelinesSource, valuesSource } from './source.js';

const SOURCE = `${valuesSource}\n${pipelinesSource}`;

// What the equations ask of the program.
export interface PipelineProgram {
  field(shape: Shape, name: string): { offset: number; shape: Shape };
  realField(shape: Shape, name: string, what: string): number;
  expr(e: A.Expr, env: Map<string, Value>): Value;
  type(t: A.Type): Shape;
  stream(name: string): Stream | null;
  known(name: string): boolean;
  /** A template by name: its parameters and the pipeline that is its whole
   *  body (null when its body is something else, which is an error). */
  template(name: string): Template | null;
  isStream(t: A.Type): boolean;
}
export interface Template {
  name: string;
  params: A.Param[];
  pipeline: A.PipelineElem[] | null;
}

// A process-typed parameter's argument: a pipeline, in the scope it was written in.
export interface Closure {
  elems: A.PipelineElem[];
  env: Map<string, Value>;
  procs: Map<string, Closure>;
}

const fail = (msg: string): never => {
  throw new ElabError(msg);
};

export function elabPipelineStages(
  P: PipelineProgram, who: string, elems: A.PipelineElem[], env: Map<string, Value>, procs: Map<string, Closure>, input: Shape,
): { stages: StageIR[]; output: Shape } {
  const m = load(SOURCE, {
    ...prelude(fail),
    P,
    R: REAL,
    empty: new Map(),
    bind: (e: Map<string, Value>, n: string, v: Value) => new Map(e).set(n, v),
    noProcs: new Map(),
    bindProc: (p: Map<string, Closure>, n: string, c: Closure) => new Map(p).set(n, c),
    lookupProc: (p: Map<string, Closure>, n: string) => p.get(n) ?? null,
  }) as { pipeline: (who: string, elems: A.PipelineElem[], env: Map<string, Value>, procs: Map<string, Closure>, input: Shape) => { stages: StageIR[]; output: Shape } };
  return m.pipeline(who, elems, env, procs, input);
}
