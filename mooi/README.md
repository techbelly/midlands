# mooi

A small equational language for writing the semantics of languages. A
definition is a list of clauses, tried in order. Patterns name syntax-tree
nodes directly, and a clause can carry a guard:

```
eval num{value} ρ       = value
eval add{left, right} ρ = eval left ρ + eval right ρ

plus num{value: a} num{value: b} = num{value: a + b}
plus num{value: 0} e             = e
plus a b                         = add{left: a, right: b}

sizes [x, ...rest] | x > 9 = ["big"] ++ sizes rest
```

Expressions are a little lambda calculus: `\x -> …`, `let p = e, … in …`,
`if`, lists, records with `...spread`, `;` for sequencing and `??` for
defaults.

Every function is curried by its arity. That covers Mooi definitions and
plain JavaScript functions alike, so a host extends Mooi by passing
functions in:

```ts
import { load } from './src/mooi.js';
import { prelude } from './src/prelude.js';

const m = load(source, { ...prelude(fail), lookup, bind });
m.eval(tree, env);
```

The implementation is three files:

- [src/mooi.ohm](src/mooi.ohm), the grammar ([Ohm](https://ohmjs.org)).
- [src/mooi.ts](src/mooi.ts), the evaluator.
- [src/prelude.ts](src/prelude.ts), the prelude: map, folds, filter and friends.

Together they are about 320 lines. [test/mooi.test.ts](test/mooi.test.ts) is a
complete small example. The large example is umgeni's front end:
[nile.mooi](../umgeni/src/semantics/nile.mooi).

*Mooi* is the Mooi River in KwaZulu-Natal, which joins the Umgeni. It is
also Afrikaans for "beautiful".
