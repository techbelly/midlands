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
pairSum xs = let [a, b] = take 2 xs, s = a + b in {sum: s, rest: drop 2 xs}
twice f x = f (f x)
answer = twice (\\x -> x * 2) 10 + 2
`;

describe('mooi', () => {
  const m = load(TOY, {
    ...prelude(fail),
    lookup: (name: string, env: Record<string, number>) => env[name] ?? null,
    bind: (env: object, name: string, value: number) => ({ ...env, [name]: value }),
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

  it('curries host and Mooi functions alike; zero-arity definitions are values', () => {
    expect(m.answer).toBe(42);
    const plus2 = app(m.plus, num(2));
    expect(app(plus2, num(3))).toEqual(num(5));
  });

  it('reports a failed match by name', () => {
    expect(() => m.sizes('nope')).toThrow(/no clause of 'sizes'/);
  });
});
