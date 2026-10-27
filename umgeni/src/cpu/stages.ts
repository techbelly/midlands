// The stages the runtime supplies: the barriers that need the whole stream
// (a stable sort by keys, which GroupBy is too; Reverse), ReduceBy, and
// the two that run a pair of pipelines over one input (DupCat, DupZip).

import type { Emit, Op, Token } from './op.js';

// A stable sort by one or more keys (flattened field offsets, major first):
// by the first key, then within equal first keys by the rest, then by
// arrival. `SortBy (@x) → SortBy (@y)` fuses to keys [y, x], and GroupBy is
// the same sort by its keys.
//
// The sort itself exploits the keys rasterization produces — pixel
// coordinates, i.e. half-integers in a bounded range: tokens are bucketed by
// the integer part of the key (O(n), stable by construction), and a bucket
// only pays for a comparison sort if it actually contains distinct keys.
// For scanline data every bucket is single-keyed, so no comparisons happen
// at all; the remaining keys then sort each bucket on its own. Keys that
// don't fit (wide range, non-finite) fall back to a plain stable sort, so
// the result is always exactly a stable sort by key.
export function sortTokens(buffer: Token[], keys: number[]): Token[] {
  if (keys.length === 0) return buffer;
  const [keyIndex, ...rest] = keys;
  const n = buffer.length;
  if (n < 2) return buffer;

  let min = Infinity;
  let max = -Infinity;
  let finite = true;
  for (const t of buffer) {
    const v = t[keyIndex];
    if (!Number.isFinite(v)) {
      finite = false;
      break;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // Bucket count must stay O(n) for this to be a win.
  if (!finite || max - min > 4 * n + 1024) {
    return sortTokens(buffer, rest).sort((a, b) => a[keyIndex] - b[keyIndex]); // native sort is stable
  }

  const base = Math.floor(min);
  const buckets: Token[][] = new Array(Math.floor(max) - base + 1);
  const mixed: boolean[] = new Array(buckets.length);
  for (const t of buffer) {
    const i = Math.floor(t[keyIndex]) - base;
    const b = buckets[i];
    if (b === undefined) {
      buckets[i] = [t];
    } else {
      if (t[keyIndex] !== b[0][keyIndex]) mixed[i] = true;
      b.push(t);
    }
  }
  const out: Token[] = [];
  for (let i = 0; i < buckets.length; i++) {
    let b = buckets[i];
    if (b === undefined) continue;
    b = sortTokens(b, rest);
    if (mixed[i]) b.sort((a, c) => a[keyIndex] - c[keyIndex]);
    for (const t of b) out.push(t);
  }
  return out;
}

// A barrier is a function on finite streams: buffer every token, apply f at
// end of stream, emit the result (whole, to a stage that takes batches).
function barrier(f: (ts: Token[]) => Token[]): Op {
  let buffer: Token[] = [];
  let emit: Emit = () => {};
  let emitAll: ((ts: Token[]) => void) | null = null;
  return {
    push(t) {
      buffer.push(t);
    },
    end() {
      const out = f(buffer);
      buffer = [];
      if (emitAll) emitAll(out);
      else for (const t of out) emit(t);
    },
    setEmit(e) {
      emit = e;
    },
    setEmitAll(e) {
      emitAll = e;
    },
  };
}

// A buffering sort stage: it stalls the streaming overlap but composes
// through the same end() propagation as any other op.
export const sortBy = (keys: number[]): Op => barrier((ts) => sortTokens(ts, keys));

// GroupBy: buffer, order by keys (major first), emit on end(). The language
// contract is key order only; a stable sort is a valid instance, so it is
// the sort.
export const groupBy = sortBy;

// ReduceBy: merge adjacent same-key runs (the upstream GroupBy guarantees
// grouping) with per-field combining functions; other fields keep the first
// token's values.
export function reduceBy(
  keyIndexes: number[],
  fields: { index: number; fn: (a: number, b: number) => number }[],
): Op {
  let cur: Token | null = null;
  let emit: Emit = () => {};
  return {
    push(t) {
      if (cur !== null && keyIndexes.every((k) => cur![k] === t[k])) {
        for (const f of fields) cur[f.index] = f.fn(cur[f.index], t[f.index]);
        return;
      }
      if (cur !== null) emit(cur);
      cur = t.slice();
    },
    end() {
      if (cur !== null) emit(cur);
      cur = null;
    },
    setEmit(e) {
      emit = e;
    },
  };
}

export const reverse = (): Op => barrier((ts) => ts.reverse());

// DupCat: the first branch streams; the second replays the buffered input
// once the first has finished.
export function dupCat(a: Op, b: Op): Op {
  const buffer: Token[] = [];
  return {
    push(t) {
      buffer.push(t);
      a.push(t);
    },
    end() {
      a.end();
      for (const t of buffer) b.push(t);
      b.end();
    },
    setEmit(e) {
      a.setEmit(e);
      b.setEmit(e);
    },
  };
}

// DupZip: both branches stream; each output of the first pairs with the
// matching output of the second, emitted as soon as both exist.
export function dupZip(a: Op, b: Op): Op {
  const qa: Token[] = [];
  const qb: Token[] = [];
  let emit: Emit = () => {};
  a.setEmit((t) => void qa.push(t));
  b.setEmit((t) => void qb.push(t));
  const pair = () => {
    const n = Math.min(qa.length, qb.length);
    for (let i = 0; i < n; i++) emit([...qa[i], ...qb[i]]);
    qa.splice(0, n);
    qb.splice(0, n);
  };
  return {
    push(t) {
      a.push(t);
      b.push(t);
      pair();
    },
    end() {
      a.end();
      b.end();
      pair();
    },
    setEmit(e) {
      emit = e;
    },
  };
}

