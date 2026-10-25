# mooi

A small language for writing down what another language means. A Mooi
program is a list of equations. Each names a function, says what shape of
input it applies to, and gives the answer; the first equation that fits is
the one used. Shapes are written the way the syntax tree is built, so
`add{left, right}` matches an addition node and names its two parts. An
equation can also carry a condition after `|`:

```
eval num{value} ρ       = value
eval add{left, right} ρ = eval left ρ + eval right ρ

plus num{value: a} num{value: b} = num{value: a + b}
plus num{value: 0} e             = e
plus a b                         = add{left: a, right: b}

sizes [x, ...rest] | x > 9 = ["big"] ++ sizes rest
```

The right-hand sides are a small expression language: anonymous functions
(`\x -> …`), `let … in …`, `if`, lists, records with `...spread`, `;` to do
one thing then another, and `??` for a default when a value is missing.

Every function takes its arguments one at a time (it is *curried*), whether
it was written in Mooi or is a plain JavaScript function the host passed in.
That is how a host extends Mooi: it hands over functions, and the equations
call them like any other.

```ts
import { load } from './src/mooi.js';
import { prelude } from './src/prelude.js';

const m = load(source, { ...prelude(fail), lookup, bind });
m.eval(tree, env);
```

The implementation is three files, about 360 lines together:

- [src/mooi.ohm](src/mooi.ohm), the grammar, which [Ohm](https://ohmjs.org) parses with.
- [src/mooi.ts](src/mooi.ts), the evaluator: matching shapes, trying equations in order, applying functions.
- [src/prelude.ts](src/prelude.ts), the prelude: map, folds, filter and friends.

[test/mooi.test.ts](test/mooi.test.ts) is a complete small example. The large
example is umgeni's definition of Nile:
[nile.mooi](../umgeni/src/semantics/nile.mooi), with
[values.mooi](../umgeni/src/semantics/values.mooi) and
[sugar.mooi](../umgeni/src/semantics/sugar.mooi).

*Mooi* is the Mooi River in KwaZulu-Natal, which joins the Umgeni. It is
also Afrikaans for "beautiful".
