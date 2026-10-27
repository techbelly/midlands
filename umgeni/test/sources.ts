// Test inputs: gezira's kernels (unmodified, from midlands/gezira), roda's,
// this suite's own fixtures, the two source lists the oracle suites share,
// the recorded answers of the 2012 runtime, and how a case is run.
import { readFileSync } from 'node:fs';
import type { Streamer } from '../src/cpu/runtime.js';

export const gezira = (name: string) => readFileSync(new URL(`../../gezira/${name}`, import.meta.url), 'utf8');
export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
export const roda = (name: string) => readFileSync(new URL(`../../roda/${name}`, import.meta.url), 'utf8');

// Gezira's strokes: mid-stream ⇒, generators, DupCat, Reverse.
export const strokeSources = (): string[] => ['types.nl', 'bezier.nl', 'stroke.nl'].map(gezira);
// Gezira's paint library (templates, DupZip, filters) and the scenes that use it.
export const paintSources = (): string[] => [...['types.nl', 'texture.nl', 'compositor.nl', 'gradient.nl', 'filter.nl'].map(gezira), fixture('paint-scenes.nl')];

// What the original C runtime produced (tools/oracle/, floats widened to
// double): a process, its parameters, an input stream, the output stream.
export interface OracleCase {
  process: string;
  params?: number[];
  input: number[][];
  output: number[][];
}
export const strokeOracle = (): OracleCase[] => (JSON.parse(fixture('stroke-oracle.json')) as { cases: OracleCase[] }).cases;
export const paintOracle = (): OracleCase[] => (JSON.parse(fixture('paint-oracle.json')) as { cases: OracleCase[] }).cases;

// Everything a process emits for an input stream, token by token then at the end.
export const collect = (s: Streamer, input: number[][]): number[][] => [...input.flatMap((t) => s.push(t)), ...s.end()];
