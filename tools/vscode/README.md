# Editor support

`nile-mooi/` is a VS Code extension: syntax highlighting for Nile (`.nl` and
the `.nl-lib` manifests) and Mooi (`.mooi`), with `--` as the comment
leader and indentation folding for both. It is two TextMate grammars and
nothing else; there is no language server.

To use it from this checkout, link it into your extensions folder and
reload VS Code:

```
ln -s "$PWD/tools/vscode/nile-mooi" ~/.vscode/extensions/midlands.nile-mooi
```

The grammars follow `umgeni/src/grammar/nile.ohm` and `mooi/src/mooi.ohm`.
Nile's user-defined operators are any run of operator glyphs, so the
grammar colours them as operators without knowing which are defined.
