// Kernel fusion: rewrite each PipelineIR into a FusedIR by inlining nested
// pipeline references and grouping consecutive kernel stages into segments.
// The payoff happens at codegen: within a segment, a stage's emit becomes a
// direct call to the next stage with scalar arguments, eliminating the
// per-token arrays and queues the unfused runtime pays between stages.
//
// Conservative bail (the whole pipeline is left unfused, which stays
// correct): a stage that isn't a compiled kernel or pipeline.

import { mapExpr, type FusedIR, type FusedSegment, type FusedStage, type ModuleIR, type PipelineIR, type ProcessIR, type ScalarExpr, type StageIR } from '../ir.js';

export function fuseModule(mod: ModuleIR): ModuleIR {
  const byName = new Map(mod.processes.map((p) => [p.name, p]));
  return {
    processes: mod.processes.map((p) => (p.k === 'pipeline' ? fusePipeline(p, byName) : p)),
  };
}

type Resolved =
  | { k: 'kernel'; stage: FusedStage }
  | Exclude<StageIR, { k: 'stage' }>;

function fusePipeline(p: PipelineIR, byName: Map<string, ProcessIR>): ProcessIR {
  const flat = flatten(p.stages, byName, 0);
  if (flat === null) return p;

  const segments: FusedSegment[] = [];
  for (const r of flat) {
    if (r.k === 'kernel') {
      const last = segments[segments.length - 1];
      if (last?.k === 'kernels') last.stages.push(r.stage);
      else segments.push({ k: 'kernels', stages: [r.stage] });
    } else {
      segments.push(r); // barrier stages pass through
    }
  }
  return { k: 'fused', name: p.name, paramWidth: p.paramWidth, segments };
}

// Resolve stages to kernels, splicing nested pipelines (their stage-argument
// expressions are rewritten from the inner parameter space to the outer one).
// Returns null to bail.
function flatten(stages: StageIR[], byName: Map<string, ProcessIR>, depth: number): Resolved[] | null {
  if (depth > 8) return null;
  const out: Resolved[] = [];
  for (const st of stages) {
    if (st.k !== 'stage') {
      out.push(st);
      continue;
    }
    const target = byName.get(st.name);
    if (!target || target.k === 'fused') return null;
    if (target.k === 'kernel') {
      out.push({ k: 'kernel', stage: { name: st.name, kernel: target, args: st.args } });
      continue;
    }
    // A nested pipeline: flatten it, then substitute its parameter refs with
    // this call's argument expressions.
    const inner = flatten(target.stages, byName, depth + 1);
    if (inner === null) return null;
    const flatArgs = st.args.flat();
    for (const r of inner) {
      out.push(
        r.k === 'kernel'
          ? {
              k: 'kernel',
              stage: { ...r.stage, args: r.stage.args.map((vec) => vec.map((e) => subst(e, flatArgs))) },
            }
          : substBarrier(r, flatArgs),
      );
    }
  }
  return out;
}

// DupCat branches name their stages with arguments too.
function substBarrier<S extends StageIR>(s: S, flatArgs: ScalarExpr[]): S {
  if (s.k === 'stage') return { ...s, args: s.args.map((vec) => vec.map((e) => subst(e, flatArgs))) };
  if (s.k === 'dupCat' || s.k === 'dupZip') return { ...s, branches: s.branches.map((b) => b.map((x) => substBarrier(x, flatArgs))) };
  return s;
}

const subst = (e: ScalarExpr, flatArgs: ScalarExpr[]): ScalarExpr =>
  mapExpr(e, (leaf) => (leaf.k === 'param' ? flatArgs[leaf.index] : leaf));
