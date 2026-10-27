// Mooi on its own: a toy expression language, given an evaluator and a
// constant folder as equations — the same shape as umgeni's nile.mooi, small.
import { describe, expect, it } from 'vitest';
import { app, load } from '../src/mooi.js';
import { prelude } from '../src/prelude.js';

const fail = (msg: string): never => {
  throw new Error(msg);
};

const TOY = `
-- Values of a toy language: numbers, variables, + and *, let.
eval num{value} ρ           = value
eval var{name} ρ            = must (lookup name ρ) ("unbound " ++ name)
eval add{left, right} ρ     = eval left ρ + eval right ρ
eval mul{left, right} ρ     = eval left ρ * eval right ρ
eval let{name, value, body} ρ = eval body (bind ρ name (eval value ρ))

-- Constant folding, by clauses: the first that matches wins.
fold add{left, right}            = plus (fold left) (fold right)
fold mul{left, right}            = times (fold left) (fold right)
fold e                           = e
plus num{value: a} num{value: b} = num{value: a + b}
plus num{value: 0} e             = e
plus e num{value: 0}             = e
plus a b                         = add{left: a, right: b}
times num{value: a} num{value: b} = num{value: a * b}
times num{value: 1} e            = e
times e num{value: 1}            = e
times a b                        = mul{left: a, right: b}

-- Lists, guards, lambdas, let with patterns.
sizes [] = []
sizes [x, ...rest] | x > 9 = ["big"] ++ sizes rest
sizes [x, ...rest]         = ["small"] ++ sizes rest
sign x
  | x < 0     = "neg"
  | x == 0    = "zero"
  | otherwise = "pos"
keep e@num{value} | value != 0 = [e]
keep _                         = []
grade x
  | x >= 70 = "first"
  | x >= 60 = "upper second"
grade x | x >= 50 = "lower second"
grade _           = "other"
pairSum xs = let [a, b] = take 2 xs, s = a + b in {sum: s, rest: drop 2 xs}
twice f x = f (f x)
answer = twice (\\x -> x * 2) 10 + 2

-- The rest of the expression language.
orElse x d   = x ?? d
clamp x      = if x < 0 then 0 else if x > 9 then 9 else x
both a b     = a; b
extend r     = {...r, z: 3, kind: "point3"}
greet name   = "hello, " ++ name
field r      = r.f
isNull null  = true
isNull _     = false
tagK scalar{expr} = expr
once         = tick unit
callsHost f  = f 5
addTo n      = \\x -> x + n
`;

describe('mooi', () => {
  let ticks = 0;
  const m = load(TOY, {
    ...prelude(fail),
    lookup: (name: string, env: Record<string, number>) => env[name] ?? null,
    bind: (env: object, name: string, value: number) => ({ ...env, [name]: value }),
    tick: () => ++ticks,
  }) as Record<string, (...a: unknown[]) => unknown>;
  const num = (value: number) => ({ kind: 'num', value });
  const v = (name: string) => ({ kind: 'var', name });
  const add = (left: object, right: object) => ({ kind: 'add', left, right });
  const mul = (left: object, right: object) => ({ kind: 'mul', left, right });

  it('evaluates by clauses over nodes', () => {
    expect(m.eval(add(num(2), mul(v('x'), num(3))), { x: 4 })).toBe(14);
    expect(m.eval({ kind: 'let', name: 'y', value: num(5), body: mul(v('y'), v('y')) }, {})).toBe(25);
    expect(() => m.eval(v('y'), {})).toThrow('unbound y');
  });

  it('folds constants, first matching clause wins', () => {
    expect(m.fold(add(num(2), num(3)))).toEqual(num(5));
    expect(m.fold(mul(num(1), add(v('x'), num(0))))).toEqual(v('x'));
    expect(m.fold(add(v('x'), mul(num(2), num(3))))).toEqual(add(v('x'), num(6)));
  });

  it('lists, guards, let patterns, records', () => {
    expect(m.sizes([3, 12, 9, 10])).toEqual(['small', 'big', 'small', 'big']);
    expect(m.pairSum([1, 2, 3])).toEqual({ sum: 3, rest: [3] });
  });

  it('stacks guards under one head; an as-pattern names the whole and its parts', () => {
    expect([m.sign(-2), m.sign(0), m.sign(5)]).toEqual(['neg', 'zero', 'pos']);
    expect(m.keep(num(3))).toEqual([num(3)]);
    expect(m.keep(num(0))).toEqual([]);
    expect(m.keep(v('x'))).toEqual([]);
    expect([m.grade(75), m.grade(65), m.grade(55), m.grade(5)]).toEqual(['first', 'upper second', 'lower second', 'other']);
  });

  it('curries host and Mooi functions alike; zero-arity definitions are values', () => {
    expect(m.answer).toBe(42);
    const plus2 = app(m.plus, num(2));
    expect(app(plus2, num(3))).toEqual(num(5));
  });

  it('reports a failed match by name', () => {
    expect(() => m.sizes('nope')).toThrow(/no clause of 'sizes'/);
  });

  it('??, ;, if, spread, field access and ++ on strings', () => {
    expect(m.orElse(null, 7)).toBe(7);
    expect(m.orElse(undefined, 7)).toBe(7);
    expect(m.orElse(0, 7)).toBe(0);
    expect(m.both(1, 2)).toBe(2);
    expect([m.clamp(-1), m.clamp(4), m.clamp(12)]).toEqual([0, 4, 9]);
    expect(m.extend({ kind: 'point', x: 1 })).toEqual({ kind: 'point3', x: 1, z: 3 });
    expect(m.greet('mooi')).toBe('hello, mooi');
    expect(m.field({ f: 4 })).toBe(4);
    expect(() => m.field(null)).toThrow("'.f' of null");
  });

  it('matches null, and nodes tagged k as well as kind', () => {
    expect(m.isNull(null)).toBe(true);
    expect(m.isNull(undefined)).toBe(true);
    expect(m.isNull(0)).toBe(false);
    expect(m.tagK({ k: 'scalar', expr: 9 })).toBe(9);
  });

  it('a definition without parameters is computed once; unit calls a zero-arity host function', () => {
    expect(m.once).toBe(1);
    expect(m.once).toBe(1);
    expect(ticks).toBe(1);
    expect(m.callsHost((x: number) => x * 3)).toBe(15);
  });

  it('a lambda applied short of its arity is a function of the rest', () => {
    const add2 = m.addTo(2) as (x: number) => number;
    expect(add2(5)).toBe(7);
    expect(app(m.twice, add2)).toBeTypeOf('function');
    expect(app(app(m.twice, add2), 1)).toBe(5);
  });

  it('refuses clauses of one name with different arities', () => {
    expect(() => load('f x = 1\nf x y = 2\n', prelude(fail))).toThrow(/differ in arity/);
  });
});
