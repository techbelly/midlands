// The streaming protocol. A token is a flat array of numbers: records are
// scalarized by elaboration, so a Bezier flows through as 6 numbers, which
// keeps the runtime shape-blind. An Op takes tokens one at a time (or a
// batch), is told the end of the stream, and emits to whoever asked. Ops
// compose into pipelines; a Streamer or run() is the host's boundary.

export type Token = number[];
export type Emit = (t: Token) => void;

export interface Op {
  push(t: Token): void;
  end(): void;
  setEmit(e: Emit): void;
  // Optional batch path, equivalent to pushing each token in order: a
  // barrier that emits its whole buffer at once hands it over in one call
  // (a wasm segment then loops inside wasm instead of crossing per token).
  pushAll?(ts: Token[]): void;
  setEmitAll?(e: (ts: Token[]) => void): void;
  // After end(): the run's whole output as one array, when the op kept it
  // (memoPipeline). run() returns that array, so a later run over it finds
  // it again: identity flows from one process's output to the next's input.
  whole?(): Token[] | null;
}

export function identity(): Op {
  let emit: Emit = () => {};
  return {
    push: (t) => emit(t),
    end: () => {},
    setEmit: (e) => {
      emit = e;
    },
  };
}

// Compose `a → b`: a's output becomes b's input; end() drains a then b.
function compose(a: Op, b: Op): Op {
  a.setEmit((t) => b.push(t));
  if (a.setEmitAll && b.pushAll) a.setEmitAll((ts) => b.pushAll!(ts));
  return {
    push: (t) => a.push(t),
    ...(a.pushAll ? { pushAll: (ts: Token[]) => a.pushAll!(ts) } : {}),
    end: () => {
      a.end();
      b.end();
    },
    setEmit: (e) => b.setEmit(e),
    ...(b.setEmitAll ? { setEmitAll: (e: (ts: Token[]) => void) => b.setEmitAll!(e) } : {}),
  };
}

export function pipeline(ops: Op[]): Op {
  if (ops.length === 0) return identity();
  return ops.reduce((acc, op) => compose(acc, op));
}

// The boundary surface: push(token) returns exactly the outputs that token
// produced; end() returns whatever the flush bodies emit.
export interface Streamer {
  push(t: Token): Token[];
  end(): Token[];
}

export function streamer(op: Op): Streamer {
  let buffer: Token[] = [];
  op.setEmit((t) => buffer.push(t));
  return {
    push(t) {
      buffer = [];
      op.push(t);
      return buffer;
    },
    end() {
      buffer = [];
      op.end();
      return buffer;
    },
  };
}

// Run a batch of tokens through an op and collect all its output.
export function run(op: Op, tokens: Token[]): Token[] {
  const out: Token[] = [];
  op.setEmit((t) => out.push(t));
  if (op.pushAll) op.pushAll(tokens);
  else for (const t of tokens) op.push(t);
  op.end();
  return op.whole?.() ?? out;
}
