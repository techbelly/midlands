// Textures on the GPU: a texture process (Point >> Color) whose pipeline is
// made of map kernels — gradients, colour spans, compositors, DupZip of
// maps — lowers to ONE WGSL function, `paint(x, y) -> vec4f` (a, r, g, b).
// Each stage's body is wgslBody over its own names; its emit becomes the
// next stage's inputs (local lets), exactly as fused JS stages call each
// other with scalar arguments. Stage parameters are WGSL
// expressions over the enclosing pipeline's — constants, for a paint.
//
// Not maps: filters (BilinearFilter, GaussianBlur…) emit several samples per
// point and reduce them with a stateful kernel. lowerTexture refuses those
// with a reason, and the caller paints on the CPU.

import type { FusedRun, KernelIR, ModuleIR, ProcessIR, StageIR } from '../ir.js';
import { isMapKernel } from './classify.js';
import { mangle, paramsOnly, wgslBody, wgslExpr, type WgslEnv, type WgslExprEnv } from './wgsl.js';

export type LoweredTexture = { ok: true; wgsl: string } | { ok: false; reason: string };

class NotMap extends Error {}

export function lowerTexture(mod: ModuleIR, name: string): LoweredTexture {
  const byName = new Map(mod.processes.map((p) => [p.name, p]));
  const lines: string[] = [];
  let unique = 0;

  // Stage u's names: its state and outputs as written here, its locals as
  // the WGSL mangler spells them, so a Nile local called out0 cannot collide.
  const ident = (u: number, n: string) => `s${u}_${n}`;

  function kernel(k: KernelIR, params: string[], inputs: string[]): string[] {
    if (!isMapKernel(k)) throw new NotMap(`'${k.name}' is not a map kernel (one output per input, no carried state)`);
    if (inputs.length !== k.inputWidth) throw new NotMap(`'${k.name}' expects ${k.inputWidth} inputs, given ${inputs.length}`);
    const u = unique++;
    const env: WgslEnv = {
      param: (i) => params[i],
      state: (i) => ident(u, `state${i}`),
      input: (i) => inputs[i],
      local: (n) => ident(u, mangle(n)),
      emit: (vals, indent) => vals.map((v, i) => `${indent}let ${ident(u, `out${i}`)} = ${v};`).join('\n'),
      feed: () => {
        throw new NotMap('feedback');
      },
    };
    // Read-only state, derived from params (LinearGradient's d, s00, …).
    k.stateInit.forEach((e, i) => lines.push(`  let ${env.state(i)} = ${wgslExpr(e, env)};`));
    lines.push(`  // ${k.name}`);
    lines.push(wgslBody(k.body, '  ', env));
    return Array.from({ length: k.outputWidth }, (_, i) => ident(u, `out${i}`));
  }

  function process(p: ProcessIR, params: string[], inputs: string[]): string[] {
    if (p.k === 'kernel') return kernel(p, params, inputs);
    const env = paramEnv(params);
    if (p.k === 'pipeline') return stages(p.stages, env, inputs);
    return p.runs.reduce((xs, run) => kernelRun(run, env, xs), inputs);
  }

  function kernelRun(run: FusedRun, env: WgslExprEnv, inputs: string[]): string[] {
    if (run.k !== 'kernels') return stages([run], env, inputs);
    return run.stages.reduce(
      (xs, st) => kernel(st.kernel, st.args.flat().map((a) => wgslExpr(a, env)), xs), inputs);
  }

  function stages(list: StageIR[], env: WgslExprEnv, inputs: string[]): string[] {
    return list.reduce((xs, st) => {
      switch (st.k) {
        case 'identity':
          return xs;
        case 'stage': {
          const target = byName.get(st.name);
          if (!target) throw new NotMap(`'${st.name}' did not compile`);
          return process(target, st.args.flat().map((a) => wgslExpr(a, env)), xs);
        }
        case 'dupZip':
          // Both branches are maps of the same point: compute both, pair them.
          return [...stages(st.branches[0], env, xs), ...stages(st.branches[1], env, xs)];
        default:
          throw new NotMap(`'${st.k}' is a whole-stream stage`);
      }
    }, inputs);
  }

  const root = byName.get(name);
  if (!root) return { ok: false, reason: `'${name}' did not compile` };
  try {
    const out = process(root, [], ['px', 'py']);
    if (out.length !== 4) return { ok: false, reason: `'${name}' produces ${out.length} values per point, not a Color` };
    return {
      ok: true,
      wgsl: [
        `// generated from Nile texture ${name}: returns (a, r, g, b), premultiplied`,
        `fn paint(px : f32, py : f32) -> vec4f {`,
        ...lines.filter((l) => l !== ''),
        `  return vec4f(${out.join(', ')});`,
        `}`,
      ].join('\n'),
    };
  } catch (e) {
    if (e instanceof NotMap) return { ok: false, reason: e.message };
    throw e;
  }
}

const paramEnv = (params: string[]): WgslExprEnv => paramsOnly((i) => params[i], (what) => { throw new NotMap(`pipeline ${what}`); });

