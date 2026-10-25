// Test inputs: gezira's kernels (unmodified, from midlands/gezira) and this
// suite's own fixtures.
import { readFileSync } from 'node:fs';

export const gezira = (name: string) => readFileSync(new URL(`../../gezira/${name}`, import.meta.url), 'utf8');
export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
export const roda = (name: string) => readFileSync(new URL(`../../roda/${name}`, import.meta.url), 'utf8');
