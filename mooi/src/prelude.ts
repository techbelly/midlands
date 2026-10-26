// The prelude: plain list and record functions, curried by arity like
// every Mooi function. Hosts add their own primitives beside these.

import { app } from './mooi.js';

type F = (...a: unknown[]) => unknown;

export function prelude(fail: (msg: string) => never): Record<string, unknown> {
  return {
    null: null, unit: undefined, true: true, false: false,
    fail,
    must: (x: unknown, msg: string) => x ?? fail(msg),
    not: (x: unknown) => !x,
    id: (x: unknown) => x,
    str: (x: unknown) => String(x),
    map: (f: F, xs: unknown[]) => xs.map((x) => app(f, x)),
    mapi: (f: F, xs: unknown[]) => xs.map((x, i) => app(app(f, x), i)),
    each: (f: F, xs: unknown[]) => void xs.forEach((x) => app(f, x)),
    eachi: (f: F, xs: unknown[]) => void xs.forEach((x, i) => app(app(f, x), i)),
    filter: (f: F, xs: unknown[]) => xs.filter((x) => app(f, x)),
    find: (f: F, xs: unknown[]) => xs.find((x) => app(f, x)) ?? null,
    all: (f: F, xs: unknown[]) => xs.every((x) => app(f, x)),
    any: (f: F, xs: unknown[]) => xs.some((x) => app(f, x)),
    foldl: (f: F, z: unknown, xs: unknown[]) => xs.reduce((acc, x) => app(app(f, acc), x), z),
    foldr: (f: F, z: unknown, xs: unknown[]) => xs.reduceRight((acc, x) => app(app(f, x), acc), z),
    zipWith: (f: F, a: unknown[], b: unknown[]) => a.map((x, i) => app(app(f, x), b[i])),
    concat: (xss: unknown[][]) => xss.flat(1),
    concatMap: (f: F, xs: unknown[]) => xs.flatMap((x) => app(f, x) as unknown[]),
    length: (xs: unknown[]) => xs.length,
    head: (xs: unknown[]) => xs[0],
    at: (xs: unknown[], i: number) => xs[i],
    take: (n: number, xs: unknown[]) => xs.slice(0, n),
    drop: (n: number, xs: unknown[]) => xs.slice(n),
    sum: (xs: number[]) => xs.reduce((a, b) => a + b, 0),
    range: (n: number) => Array.from({ length: n }, (_, i) => i),
    member: (x: unknown, xs: unknown[]) => xs.includes(x),
    indexOf: (x: unknown, xs: unknown[]) => (xs.indexOf(x) < 0 ? null : xs.indexOf(x)),
  };
}
