// Presentation: many paths rasterized and composited on the GPU, straight to
// a canvas — the text, paint and tiger demos all draw through it.
//
// Per frame, for each path: clear the grids and coverage over the path's
// rows → the plan's passes (lower.ts, with a coverage sink) → a blended
// fullscreen draw of the coverage in the path's colour (or a paint lowered
// from Nile). All paths (the tiger's 240, say) encode into ONE command buffer
// and ONE submission: zero fences. Per-path variation (token count, input
// offset, colour, band) rides on dynamic buffer offsets, so the generated
// shaders run unmodified.
//
// Each path's clears and draw are bounded to its rows, and its passes to its
// bounding box. Paths still run one after another (they share the grids), so
// a frame costs roughly a fixed amount per path; rasterizing all paths in
// one batch is the next step.

import { createExecutor, metaWords } from './execute.js';
import { META_BYTES, type Plan } from './lower.js';

export interface PathBatch {
  tokens: Float32Array<ArrayBuffer>; // n × plan.inputWidth flat, already transformed/clipped
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
struct Frame { width : u32, height : u32 }
struct Color { rgba : vec4f }
@group(0) @binding(0) var<uniform> FRAME : Frame;
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
  if (x < FRAME.width && y < FRAME.height) {
    cov = min(COV[y * FRAME.width + x], 1.0);
  }
  ${paint
    ? 'let c = paint(p.x, p.y); // (a, r, g, b), premultiplied\n  return vec4f(c.y, c.z, c.w, c.x) * cov;'
    : 'return vec4f(COLOR.rgba.rgb * cov, cov); // premultiplied src-over'}
}
${paint ?? ''}
`;

// The plan's grid is the frame: extent [height, width], its sink COV.
export function createPresenter(
  device: GPUDevice,
  plan: Plan,
  opts: { format: GPUTextureFormat; disableBands?: boolean; paint?: string },
): Presenter {
  const [height, width] = plan.extent;
  const { format } = opts;
  const x = createExecutor(device, plan, { dynamic: true });
  const uStride = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
  const sAlign = Math.max(256, device.limits.minStorageBufferOffsetAlignment);
  const tokenBytes = plan.inputWidth * 4;
  const aligned = (n: number) => Math.ceil((n * tokenBytes) / sAlign) * sAlign;

  const layoutC = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
    ],
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

  const frameBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(frameBuf, 0, new Uint32Array([width, height, 0, 0]));
  const cov = device.createBuffer({ size: plan.cells * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

  let pathCap = 0;
  let inCap = 0;
  let maxPathBytes = 0; // the dynamic INBUF binding needs one fixed bound size
  let metaBuf: GPUBuffer | null = null;
  let colorBuf: GPUBuffer | null = null;
  let inBuf: GPUBuffer | null = null;
  let groups: GPUBindGroup[] = [];
  let bindC: GPUBindGroup | null = null;

  function ensure(paths: PathBatch[]): void {
    let needIn = 0;
    let maxBytes = 4096;
    for (const p of paths) {
      needIn += aligned(p.n);
      maxBytes = Math.max(maxBytes, aligned(p.n));
    }
    // Every path binds maxPathBytes at its own offset, so the buffer must
    // extend that far past the last offset — not just hold the paths. (Short
    // of this, a large frame fails validation and the whole submission is
    // dropped: the tiger went black at 4× zoom.)
    maxBytes = Math.max(maxBytes, maxPathBytes);
    needIn += maxBytes;
    if (paths.length <= pathCap && needIn <= inCap && maxBytes <= maxPathBytes) return;
    pathCap = Math.max(paths.length, pathCap, 64);
    inCap = Math.max(needIn, inCap * 2, 1 << 20);
    maxPathBytes = maxBytes;
    metaBuf?.destroy();
    colorBuf?.destroy();
    inBuf?.destroy();
    metaBuf = device.createBuffer({ size: pathCap * uStride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    colorBuf = device.createBuffer({ size: pathCap * uStride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    inBuf = device.createBuffer({ size: inCap, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    groups = x.bind({ meta: metaBuf, input: inBuf, inputSize: maxPathBytes, sink: { COV: cov } });
    bindC = device.createBindGroup({
      layout: layoutC,
      entries: [
        { binding: 0, resource: { buffer: frameBuf } },
        { binding: 1, resource: { buffer: cov } },
        { binding: 2, resource: { buffer: colorBuf, size: 16 } },
      ],
    });
  }

  // A path's bounding box, as a band of rows and a range of columns, each
  // padded a pixel; or the whole frame.
  function box(p: PathBatch): { r0: number; r1: number; c0: number; c1: number } {
    if (opts.disableBands) return { r0: 0, r1: height, c0: 0, c1: width };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let j = 0; j < p.n * plan.inputWidth; j += 2) {
      const px = p.tokens[j], py = p.tokens[j + 1];
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
    const r0 = Math.max(0, Math.floor(y0) - 1);
    const c0 = Math.max(0, Math.floor(x0) - 1);
    return { r0, r1: Math.max(r0, Math.min(height, Math.ceil(y1) + 2)), c0, c1: Math.max(c0, Math.min(width, Math.ceil(x1) + 2)) };
  }

  return {
    frame(paths, target) {
      const drawable = paths.filter((p) => p.n > 0);
      ensure(drawable);
      // Upload per-path meta, colours and tokens at aligned offsets.
      const boxes = drawable.map(box);
      const inOffsets: number[] = [];
      let at = 0;
      drawable.forEach((p, i) => {
        const b = boxes[i];
        inOffsets.push(at);
        device.queue.writeBuffer(metaBuf!, i * uStride, metaWords(p.n, plan.extent, { segBase: b.r0, segEnd: b.r1, minBase: b.c0, minEnd: b.c1 }));
        device.queue.writeBuffer(colorBuf!, i * uStride, new Float32Array([...p.color, 1]));
        device.queue.writeBuffer(inBuf!, at, p.tokens, 0, p.n * plan.inputWidth);
        at += aligned(p.n);
      });

      const enc = device.createCommandEncoder({ label: 'present-frame' });
      // Clear the target on its own. (Folding the clear into the first path's
      // draw left that draw unscissored, so it painted the coverage buffer's
      // stale rows outside its band — ghosts whenever the drawing shrank.)
      enc.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 1, b: 1, a: 1 } }],
      }).end();
      // Each path clears, computes and draws only its own row band: rows
      // outside it hold earlier paths' (or frames') coverage.
      drawable.forEach((p, i) => {
        const { r0, r1, c0, c1 } = boxes[i];
        const rows = r1 - r0;
        if (rows === 0 || c1 === c0) return;
        x.clearGrids(enc, r0 * width, rows * width);
        enc.clearBuffer(cov, r0 * width * 4, rows * width * 4);
        x.encode(enc, groups, { n: p.n, segments: rows, metaOffset: i * uStride, inputOffset: inOffsets[i] });
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }] });
        rp.setPipeline(pipeC);
        rp.setBindGroup(0, bindC!, [i * uStride]);
        rp.setScissorRect(c0, r0, c1 - c0, rows);
        rp.draw(3);
        rp.end();
      });
      device.queue.submit([enc.finish()]); // one submission, zero fences
    },
    dispose() {
      for (const b of [frameBuf, cov, metaBuf, colorBuf, inBuf]) b?.destroy();
      x.dispose();
    },
  };
}
