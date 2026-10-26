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
(`\x -> …`), `let … in …` (several bindings separated by commas, each a
pattern), `if … then … else …`, lists, records with `...spread`, field
access `x.f`, `;` to do one thing then another, and `??` for a default
when a value is missing. The operators are `+ - * /`, `++` (strings or
lists), the comparisons, `&&` and `||` (both short-circuit).

## Syntax

- A definition starts at column 0; its continuation lines are indented.
  `--` starts a comment.
- A pattern is a name, `_`, a number, a string, `null`, a node
  `name{f1, f2: p}` (a field alone binds a variable of that name; `f: p`
  matches `p` against it; there must be no space before the `{`), a list
  `[]`, `[p, q]` or `[p, ...rest]`, or a pattern in parentheses.
- A node pattern matches an object whose `kind` or `k` field is the name.
  The node expression `name{…}` always builds `{kind: name, …}`; a record
  with a `k` tag is written out, `{k: "scalar", expr: x}`.
- Strings have no escapes. `null` and `undefined` are one missing value:
  `==` treats them as equal, and `??` steps over either.

## Host conventions

- Every function is curried by its arity, read from the JavaScript
  function's `length`: a host function with default or rest parameters has
  the wrong arity, so write it with plain parameters.
- A zero-arity host function is called by applying it to `unit`, the
  prelude's name for `undefined`: `c.get unit`.
- A definition with no parameters is a value, computed once on first use.
- A Mooi definition shadows a host name of the same name.
- `prelude(fail)` supplies the list functions, `must x msg` (x or fail),
  `null`, `unit`, `true` and `false`.

The implementation is about 365 lines:

- [src/mooi.ohm](src/mooi.ohm), the grammar, which [Ohm](https://ohmjs.org) parses with.
- [src/mooi.ts](src/mooi.ts), the evaluator: matching shapes, trying equations in order, applying functions.
- [src/prelude.ts](src/prelude.ts), the prelude: map, folds, filter and friends.
- [src/source.ts](src/source.ts) and its browser twin, which read the grammar in Node or in a bundle.

[test/mooi.test.ts](test/mooi.test.ts) is a complete small example. The large
example is umgeni's definition of Nile:
[nile.mooi](../umgeni/src/semantics/nile.mooi), with
[values.mooi](../umgeni/src/semantics/values.mooi) and
[sugar.mooi](../umgeni/src/semantics/sugar.mooi).

*Mooi* is the Mooi River in KwaZulu-Natal, which joins the Umgeni. It is
also Afrikaans for "beautiful".
