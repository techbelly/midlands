// The streaming runtime, as generated code (js.ts) and hosts call it: one
// name gathering the protocol and composition (op.ts), the stages the
// runtime supplies (stages.ts), work kept between runs (memo.ts), the
// WebAssembly instances (wasm-instance.ts) and the library API (api.ts).
// Kernels themselves are generated code: every kernel runs as a run of one,
// with feedback as a LIFO worklist, so recursive subdivision runs
// depth-first as iteration, not JS recursion.

export * from './op.js';
export * from './stages.js';
export * from './memo.js';
export * from './wasm-instance.js';
export * from './api.js';
