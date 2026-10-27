// Presentation: many paths rasterized and composited on the GPU, straight to
// a canvas — the text, paint, tiger and samples demos all draw through it.
//
// Per frame, for each path: clear the grids and coverage over the path's
// rows → the plan's passes (lower.ts, with a coverage sink) → a blended
// fullscreen draw of the coverage in the path's colour (or a paint lowered
// from Nile). All paths (the tiger's 240, say) encode into ONE command buffer
// and ONE submission: zero fences. Per-path variation (token count, input
// offset, colour, band) rides on dynamic buffer offsets, so the generated
// shaders run unmodified.
//
// A frame may draw its paths through several plans (the samples page fills
// under either rule): each path names its plan, and the plans share the
// frame's extent and coverage. Each path's clears and draw are bounded to
// its rows, and its passes to its bounding box. Paths still run one after
// another (they share the grids), so a frame costs roughly a fixed amount
// per path; rasterizing all paths in one batch is the next step.

import type { FusedIR } from '../ir.js';
import { coverageSink, createExecutor, type Executor } from './execute.js';
import { bandSegments, lowerPipeline, META_BYTES, metaWords, wholeGrid, type Band, type Plan } from './lower.js';

export interface PathBatch {
  tokens: Float32Array<ArrayBuffer>; // n × plan.inputWidth flat, already transformed/clipped
  n: number;
  color: readonly [number, number, number] | readonly [number, number, number, number]; // 0..1, alpha 1 if absent
  plan?: string; // which of the presenter's plans; the only one, if absent
}
// A batch from flat beziers: the tokens as f32, their count, the colour.
export const pathBatch = (beziers: number[][], color: PathBatch['color'], plan?: string): PathBatch =>
  ({ tokens: new Float32Array(beziers.flat()), n: beziers.length, color, ...(plan ? { plan } : {}) });

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
    : 'let a = cov * COLOR.rgba.a;\n  return vec4f(COLOR.rgba.rgb * a, a); // premultiplied src-over'}
}
${paint ?? ''}
`;

// The plans' grid is the frame: extent [height, width], their sink COV.
// framePlan lowers a fused pipeline that way.
export const framePlan = (fused: FusedIR, width: number, height: number): Plan =>
  lowerPipeline(fused, { extent: [height, width], sink: coverageSink });

const isPlan = (p: Plan | Record<string, Plan>): p is Plan => Array.isArray((p as Plan).passes);

export function createPresenter(
  device: GPUDevice,
  plan: Plan | Record<string, Plan>,
  opts: { format: GPUTextureFormat; disableBands?: boolean; paint?: string },
): Presenter {
  const plans: Record<string, Plan> = isPlan(plan) ? { [plan.name]: plan } : plan;
  const names = Object.keys(plans);
  if (names.length === 0) throw new Error('a presenter needs at least one plan');
  const first = plans[names[0]];
  const [height, width] = first.extent;
  for (const n of names) {
    if (plans[n].extent[0] !== height || plans[n].extent[1] !== width) throw new Error(`plan '${n}' has a different extent from '${names[0]}'`);
  }
  const uStride = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
  const sAlign = Math.max(256, device.limits.minStorageBufferOffsetAlignment);

  // A lane: one of the presenter's plans and the executor that runs it. A
  // path names its lane (or takes the only one).
  interface Lane { name: string; plan: Plan; executor: Executor }
  const lanes: Record<string, Lane> = {};
  for (const n of names) lanes[n] = { name: n, plan: plans[n], executor: createExecutor(device, plans[n], { dynamic: true }) };
  const laneOf = (p: PathBatch): Lane => {
    const lane = lanes[p.plan ?? names[0]];
    if (!lane) throw new Error(`no plan '${p.plan}' in this presenter`);
    return lane;
  };
  // A path in a frame: its lane, the band of the frame it touches, and the
  // bytes its tokens take at the storage alignment.
  interface Item { p: PathBatch; lane: Lane; band: Band; bytes: number }
  const item = (p: PathBatch): Item => {
    const lane = laneOf(p);
    return { p, lane, band: bandOf(p, lane.plan.inputWidth), bytes: Math.ceil((p.n * lane.plan.inputWidth * 4) / sAlign) * sAlign };
  };

  const frameBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(frameBuf, 0, new Uint32Array([width, height, 0, 0]));
  const cov = device.createBuffer({ size: first.cells * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const compositor = createCompositor(device, opts.format, opts.paint, frameBuf, cov);

  // The per-frame buffers, sized for the largest frame so far and regrown
  // together: per-path meta and colours at uniform stride, the paths' tokens
  // at aligned offsets, and the bind groups over them.
  interface FrameBuffers {
    pathCap: number;
    inCap: number;
    maxPathBytes: number; // the dynamic INBUF binding needs one fixed bound size
    meta: GPUBuffer;
    color: GPUBuffer;
    input: GPUBuffer;
    groups: Record<string, GPUBindGroup[]>;
    composite: GPUBindGroup;
  }
  let buffers: FrameBuffers | null = null;
  const allocate = (pathCap: number, inCap: number, maxPathBytes: number): FrameBuffers => {
    const meta = device.createBuffer({ size: pathCap * uStride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const color = device.createBuffer({ size: pathCap * uStride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const input = device.createBuffer({ size: inCap, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const groups: Record<string, GPUBindGroup[]> = {};
    for (const n of names) groups[n] = lanes[n].executor.bind({ meta, input, inputSize: maxPathBytes, sink: { COV: cov } });
    return { pathCap, inCap, maxPathBytes, meta, color, input, groups, composite: compositor.bind(color) };
  };
  const release = (b: FrameBuffers) => { for (const buf of [b.meta, b.color, b.input]) buf.destroy(); };

  // Buffers that hold these paths: the current ones if they fit, else larger.
  function ensure(items: Item[]): FrameBuffers {
    let needIn = 0;
    let maxBytes = 4096;
    for (const it of items) {
      needIn += it.bytes;
      maxBytes = Math.max(maxBytes, it.bytes);
    }
    // Every path binds maxPathBytes at its own offset, so the buffer must
    // extend that far past the last offset — not just hold the paths. (Short
    // of this, a large frame fails validation and the whole submission is
    // dropped: the tiger went black at 4× zoom.)
    maxBytes = Math.max(maxBytes, buffers?.maxPathBytes ?? 0);
    needIn += maxBytes;
    if (buffers && items.length <= buffers.pathCap && needIn <= buffers.inCap && maxBytes <= buffers.maxPathBytes) return buffers;
    const old = buffers;
    buffers = allocate(Math.max(items.length, old?.pathCap ?? 0, 64), Math.max(needIn, (old?.inCap ?? 0) * 2, 1 << 20), maxBytes);
    if (old) release(old);
    return buffers;
  }

  // The band of the frame a path touches: its bounding box padded a pixel,
  // rows as segments and columns as the minor key; or the whole frame. A
  // token is (x, y) pairs throughout (a Bezier is three points), so every
  // even slot is an x and every odd one a y.
  function bandOf(p: PathBatch, w: number): Band {
    if (opts.disableBands) return wholeGrid(first.extent);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let j = 0; j < p.n * w; j += 2) {
      const px = p.tokens[j], py = p.tokens[j + 1];
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
    const segBase = Math.max(0, Math.floor(y0) - 1);
    const minBase = Math.max(0, Math.floor(x0) - 1);
    return { segBase, segEnd: Math.max(segBase, Math.min(height, Math.ceil(y1) + 2)), minBase, minEnd: Math.max(minBase, Math.min(width, Math.ceil(x1) + 2)) };
  }

  return {
    frame(paths, target) {
      const items = paths.filter((p) => p.n > 0).map(item);
      const b = ensure(items);
      // Upload per-path meta, colours and tokens at aligned offsets.
      const inOffsets: number[] = [];
      let at = 0;
      items.forEach(({ p, lane, band, bytes }, i) => {
        inOffsets.push(at);
        device.queue.writeBuffer(b.meta, i * uStride, metaWords(p.n, lane.plan.extent, band));
        device.queue.writeBuffer(b.color, i * uStride, new Float32Array([p.color[0], p.color[1], p.color[2], p.color[3] ?? 1]));
        device.queue.writeBuffer(b.input, at, p.tokens, 0, p.n * lane.plan.inputWidth);
        at += bytes;
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
      items.forEach(({ p, lane, band }, i) => {
        const rows = bandSegments(band);
        if (rows === 0 || band.minEnd === band.minBase) return;
        lane.executor.clearGrids(enc, band.segBase * width, rows * width);
        enc.clearBuffer(cov, band.segBase * width * 4, rows * width * 4);
        lane.executor.encode(enc, b.groups[lane.name], { n: p.n, band, metaOffset: i * uStride, inputOffset: inOffsets[i] });
        compositor.draw(enc, target, b.composite, i * uStride, band);
      });
      device.queue.submit([enc.finish()]); // one submission, zero fences
    },
    dispose() {
      frameBuf.destroy();
      cov.destroy();
      if (buffers) release(buffers);
      for (const n of names) lanes[n].executor.dispose();
    },
  };
}

// The composite pass: a fullscreen draw of the coverage in a path's colour
// (or paint), blended onto the target and scissored to the path's band.
function createCompositor(device: GPUDevice, format: GPUTextureFormat, paint: string | undefined, frameBuf: GPUBuffer, cov: GPUBuffer) {
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
    ],
  });
  const module = device.createShaderModule({ code: compositeShader(paint), label: 'present-composite' });
  const pipeline = device.createRenderPipeline({
    label: 'present-composite',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
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
  return {
    // The bind group over a colour buffer (one colour per path, at a dynamic offset).
    bind: (color: GPUBuffer): GPUBindGroup =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: frameBuf } },
          { binding: 1, resource: { buffer: cov } },
          { binding: 2, resource: { buffer: color, size: 16 } },
        ],
      }),
    draw(enc: GPUCommandEncoder, target: GPUTextureView, bind: GPUBindGroup, colorOffset: number, band: Band): void {
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }] });
      rp.setPipeline(pipeline);
      rp.setBindGroup(0, bind, [colorOffset]);
      rp.setScissorRect(band.minBase, band.segBase, band.minEnd - band.minBase, bandSegments(band));
      rp.draw(3);
      rp.end();
    },
  };
}
