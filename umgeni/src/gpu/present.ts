// Presentation: many paths rasterized and composited on the GPU, straight to
// a canvas — the text, paint and tiger demos all draw through it.
//
// Per frame, for each path: clear grids+coverage → pass A (decompose, the
// source-lowered shader) → pass B (resolve) → a blended fullscreen draw of
// the coverage in the path's color (or a paint lowered from Nile). All
// paths (the tiger's 240, say) encode into ONE command buffer and ONE
// submission: zero fences. Per-path variation (token count,
// input offset, color) rides on dynamic buffer offsets, so the generated
// shaders run unmodified; only this compositor is new, and it is
// presentation scaffolding, not kernel logic.
//
// Each path's clears and draw are bounded to its rows, and its resolve to
// its bounding box. Paths still run one after another (they share the grids),
// so a frame costs roughly a fixed amount per path; rasterizing all paths in
// one batch is the next step.

import type { LoweredShaders } from './lower.js';
import { WORKGROUP_SIZE } from './wgsl.js';

export interface PathBatch {
  beziers: Float32Array<ArrayBuffer>; // n×6 flat, already transformed/clipped
  n: number;
  color: readonly [number, number, number]; // 0..1
}

export interface Presenter {
  /** Encode and submit the whole frame. Zero fences. */
  frame(paths: PathBatch[], target: GPUTextureView): void;
  dispose(): void;
}

// The composite pass: coverage × the path's colour — or, given a texture
// lowered from Nile (gpu/texture.ts), coverage × paint(pixel centre).
const compositeShader = (paint?: string) => `
struct Meta { n : u32, width : u32, height : u32 }
struct Color { rgba : vec4f }
@group(0) @binding(0) var<uniform> META : Meta;
@group(0) @binding(1) var<storage, read> COV : array<f32>;
@group(0) @binding(2) var<uniform> COLOR : Color;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  return vec4f(pos[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) p : vec4f) -> @location(0) vec4f {
  let x = u32(p.x);
  let y = u32(p.y);
  var cov = 0.0;
  if (x < META.width && y < META.height) {
    cov = min(COV[y * META.width + x], 1.0);
  }
  ${paint
    ? 'let c = paint(p.x, p.y); // (a, r, g, b), premultiplied\n  return vec4f(c.y, c.z, c.w, c.x) * cov;'
    : 'return vec4f(COLOR.rgba.rgb * cov, cov); // premultiplied src-over'}
}
${paint ?? ''}
`;

export function createPresenter(
  device: GPUDevice,
  shaders: LoweredShaders,
  opts: { width: number; height: number; format: GPUTextureFormat; disableBands?: boolean; paint?: string },
): Presenter {
  const { width, height, format } = opts;
  const uStride = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
  const sAlign = Math.max(256, device.limits.minStorageBufferOffsetAlignment);

  // Explicit layouts (dynamic offsets require them; 'auto' cannot).
  const layoutA = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage', hasDynamicOffset: true } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const layoutB = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const layoutC = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
    ],
  });

  const pipeA = device.createComputePipeline({
    label: 'present-decompose',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutA] }),
    compute: { module: device.createShaderModule({ code: shaders.decompose }), entryPoint: 'main' },
  });
  const pipeB = device.createComputePipeline({
    label: 'present-resolve',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutB] }),
    compute: { module: device.createShaderModule({ code: shaders.resolve }), entryPoint: 'main' },
  });
  const compositeModule = device.createShaderModule({ code: compositeShader(opts.paint), label: 'present-composite' });
  const pipeC = device.createRenderPipeline({
    label: 'present-composite',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutC] }),
    vertex: { module: compositeModule, entryPoint: 'vs' },
    fragment: {
      module: compositeModule,
      entryPoint: 'fs',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const gridBytes = width * height * 4;
  // Frame-constant meta for the composite pass (per-path metas carry band
  // bounds in their height slot and must not leak into the fragment shader).
  const frameMeta = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(frameMeta, 0, new Uint32Array([0, width, height, 0]));
  const gridA = device.createBuffer({ size: gridBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const gridH = device.createBuffer({ size: gridBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const cov = device.createBuffer({ size: gridBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const overflow = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

  let pathCap = 0;
  let inCap = 0;
  let metaBuf: GPUBuffer | null = null;
  let colorBuf: GPUBuffer | null = null;
  let inBuf: GPUBuffer | null = null;
  let bindA: GPUBindGroup | null = null;
  let bindB: GPUBindGroup | null = null;
  let bindC: GPUBindGroup | null = null;

  // The dynamic INBUF binding needs a fixed bound size; use the maximum a
  // path may need and rebuild when either capacity grows.
  let maxPathBytes = 0;

  function ensure(paths: PathBatch[]): void {
    const needPaths = paths.length;
    let needIn = 0;
    let maxBytes = 4096;
    for (const p of paths) {
      needIn += Math.ceil((p.n * 24) / sAlign) * sAlign;
      maxBytes = Math.max(maxBytes, Math.ceil((p.n * 24) / sAlign) * sAlign);
    }
    // Every path binds maxPathBytes at its own offset, so the buffer must
    // extend that far past the last offset — not just hold the paths. (Short
    // of this, a large frame fails validation and the whole submission is
    // dropped: the tiger went black at 4× zoom.)
    maxBytes = Math.max(maxBytes, maxPathBytes);
    needIn += maxBytes;
    if (needPaths <= pathCap && needIn <= inCap && maxBytes <= maxPathBytes) return;
    pathCap = Math.max(needPaths, pathCap, 64);
    inCap = Math.max(needIn, inCap * 2, 1 << 20);
    maxPathBytes = maxBytes;
    metaBuf?.destroy();
    colorBuf?.destroy();
    inBuf?.destroy();
    metaBuf = device.createBuffer({ size: pathCap * uStride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    colorBuf = device.createBuffer({ size: pathCap * uStride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    inBuf = device.createBuffer({ size: inCap, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    bindA = device.createBindGroup({
      layout: layoutA,
      entries: [
        { binding: 0, resource: { buffer: metaBuf, size: 32 } },
        { binding: 1, resource: { buffer: inBuf, size: maxPathBytes } },
        { binding: 2, resource: { buffer: gridA } },
        { binding: 3, resource: { buffer: gridH } },
        { binding: 4, resource: { buffer: overflow } },
      ],
    });
    bindB = device.createBindGroup({
      layout: layoutB,
      entries: [
        { binding: 0, resource: { buffer: metaBuf, size: 32 } },
        { binding: 1, resource: { buffer: gridA } },
        { binding: 2, resource: { buffer: gridH } },
        { binding: 3, resource: { buffer: cov } },
      ],
    });
    bindC = device.createBindGroup({
      layout: layoutC,
      entries: [
        { binding: 0, resource: { buffer: frameMeta } },
        { binding: 1, resource: { buffer: cov } },
        { binding: 2, resource: { buffer: colorBuf, size: 16 } },
      ],
    });
  }

  return {
    frame(paths, target) {
      const drawable = paths.filter((p) => p.n > 0);
      ensure(drawable);
      // Upload per-path meta, colors, and beziers at aligned offsets; bound
      // each path to its bounding box: rows for the clears and the draw,
      // rows and columns for the resolve.
      const inOffsets: number[] = [];
      const bands: [number, number][] = [];
      const cols: [number, number][] = [];
      let at = 0;
      for (let i = 0; i < drawable.length; i++) {
        const p = drawable[i];
        inOffsets.push(at);
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (let j = 0; j < p.n * 6; j += 2) {
          const x = p.beziers[j];
          const y = p.beziers[j + 1];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        const c0 = opts.disableBands ? 0 : Math.max(0, Math.floor(x0) - 1);
        const c1 = opts.disableBands ? width : Math.min(width, Math.ceil(x1) + 2);
        cols.push([c0, Math.max(c0, c1)]);
        const r0 = opts.disableBands ? 0 : Math.max(0, Math.floor(y0) - 1);
        const r1 = opts.disableBands ? height : Math.min(height, Math.ceil(y1) + 2);
        bands.push([r0, Math.max(r0, r1)]);
        // height slot = band end: bounds pass A's grid writes and pass B's
        // rows to exactly this path's band (workgroup rounding stays inside);
        // the last two slots bound pass B's columns to the path's box.
        device.queue.writeBuffer(metaBuf!, i * uStride, new Uint32Array([p.n, width, Math.max(r0, r1), r0, c0, Math.max(c0, c1)]));
        device.queue.writeBuffer(colorBuf!, i * uStride, new Float32Array([...p.color, 1]));
        device.queue.writeBuffer(inBuf!, at, p.beziers, 0, p.n * 6);
        at += Math.ceil((p.n * 24) / sAlign) * sAlign;
      }

      const enc = device.createCommandEncoder({ label: 'present-frame' });
      // Clear the target on its own. (Folding the clear into the first path's
      // draw left that draw unscissored, so it painted the coverage buffer's
      // stale rows outside its band — ghosts whenever the drawing shrank.)
      enc.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 1, b: 1, a: 1 } }],
      }).end();
      // Each path clears, computes and draws only its own row band: rows
      // outside it hold earlier paths' (or frames') coverage.
      for (let i = 0; i < drawable.length; i++) {
        const [r0, r1] = bands[i];
        const rows = r1 - r0;
        if (rows === 0) continue;
        const bandOff = r0 * width * 4;
        const bandBytes = rows * width * 4;
        enc.clearBuffer(gridA, bandOff, bandBytes);
        enc.clearBuffer(gridH, bandOff, bandBytes);
        enc.clearBuffer(cov, bandOff, bandBytes);
        let pass = enc.beginComputePass();
        pass.setPipeline(pipeA);
        pass.setBindGroup(0, bindA!, [i * uStride, inOffsets[i]]);
        pass.dispatchWorkgroups(Math.ceil(drawable[i].n / WORKGROUP_SIZE));
        pass.end();
        pass = enc.beginComputePass();
        pass.setPipeline(pipeB);
        pass.setBindGroup(0, bindB!, [i * uStride]);
        pass.dispatchWorkgroups(Math.ceil(rows / WORKGROUP_SIZE));
        pass.end();
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }] });
        rp.setPipeline(pipeC);
        rp.setBindGroup(0, bindC!, [i * uStride]);
        const [c0, c1] = cols[i];
        if (c1 === c0) { rp.end(); continue; }
        rp.setScissorRect(c0, r0, c1 - c0, rows);
        rp.draw(3);
        rp.end();
      }
      device.queue.submit([enc.finish()]); // one submission, zero fences
    },
    dispose() {
      for (const b of [frameMeta, gridA, gridH, cov, overflow, metaBuf, colorBuf, inBuf]) b?.destroy();
    },
  };
}
