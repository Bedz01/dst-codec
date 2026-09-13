# dst-codec

Reads and writes AutoCAD / ARES Commander Sheet Set files (`*.dst`) - plain UTF-8 XML (`<AcSmDatabase>…`) run through a fixed one-byte substitution cipher when written to disk. No compression, checksum, or header: substitute the bytes back and it's just XML.

**100% language coverage.** Latin, Greek, Cyrillic, Armenian, Hebrew, Arabic, Devanagari, CJK, emojis, and other scripts all decode and re-encode correctly.

## The formula

`.dst` files contain UTF-8 XML encoded with a fixed byte-substitution cipher.

The encoding is byte-for-byte: each `.dst` byte is split into a 4-bit **block** and a 4-bit **index**, then mapped to an XML byte:

```text
xml = BLOCK_BASE[dst >> 4] + PERMUTE[dst & 0xF]
```

In other words:

* `dst >> 4` selects the block from the byte's high nibble.
* `dst & 0xF` selects an entry from `PERMUTE` using the low nibble.
* `BLOCK_BASE[block]` supplies the starting XML byte for that block.
* The two values are added to produce the final XML byte.

`PERMUTE` is the same fixed 16-entry permutation for every block, and is self-inverse:

```text
PERMUTE = [13, 12, 15, 14, 9, 8, 11, 10, 5, 4, 7, 6, 1, 0, 3, 2]
```

`BLOCK_BASE` provides each block's offset. Only these blocks are confirmed; `dstToXml` / `xmlToDst` return `undefined` for all others.

| block | dst range | xml range | base | notes                          |
| ----- | --------- | --------- | ---: | ------------------------------ |
| `0x0` | 0–15      | 127–142   |  127 | Full                           |
| `0x1` | 16–31     | 111–126   |  111 | `o`–`z`, `{` `\|` `}` `~`      |
| `0x2` | 32–47     | 159–174   |  159 | Latin-1 Supplement             |
| `0x3` | 48–63     | 143–158   |  143 | Full                           |
| `0x4` | 64–79     | 191–206   |  191 | UTF-8 lead bytes               |
| `0x5` | 80–95     | 175–190   |  175 | Full                           |
| `0x6` | 96–111    | 223–238   |  223 | 3-byte UTF-8 lead bytes        |
| `0x7` | 112–127   | 207–222   |  207 | Greek/Cyrillic/etc. lead bytes |
| `0x9` | 144–159   | 239–254   |  239 | 4-byte UTF-8 lead bytes        |
| `0xa` | 160–175   | 31–46     |   31 | Punctuation & XML syntax       |
| `0xc` | 192–207   | 63–78     |   63 | Full                           |
| `0xd` | 208–223   | 47–62     |   47 | Includes `<`                   |
| `0xe` | 224–239   | 95–110    |   95 | Full                           |
| `0xf` | 240–255   | 79–94     |   79 | Full                           |

The confirmed blocks tile one gapless XML range: **31–254**. Every valid UTF-8 lead byte (`0xC2`–`0xF4`) falls inside that range, so normal UTF-8 text across all languages and scripts is covered.

Block `0xb` (`dst` 176–191) is the only unconfirmed cipher block; its possible XML range would be `0`–`30`, which contains only C0 control characters and therefore isn't needed for normal text.

Block `0x8` is reserved for the separate `TAB`/`LF` substitutions, rather than being an unknown cipher block.

**LF encoding:** `encodeDst` writes `131` (AutoCAD's confirmed-safe LF byte) instead of ARES's `135`.

### Every byte is substituted

The cipher applies to **every byte**; there is no literal pass-through for XML syntax such as `<`, `>`, `&`, or `"`. These go through the same block/`PERMUTE` mapping as everything else.

The only separate handling is for `TAB` and `LF`.

## Usage

```js
import { decodeDst, encodeDst, dstSheets } from "./dstCodec.js";

const xml = decodeDst(await Deno.readFile("sheetset.dst")); // -> XML text

await Deno.writeFile("sheetset.dst", encodeDst(xml));       // -> .dst bytes

for (const sheet of dstSheets(xml)) {
    console.log(sheet.number, sheet.title, sheet.file, sheet.handle);
}
```

`decodeDst` returns valid XML text - entities such as `&amp;` are left intact, not unescaped. Reading the actual content of a specific field (such as a title) is a separate step handled by `dstSheets`; unescaping during decoding would make literal `&amp;` content indistinguishable from XML syntax.

### CLI

```text
deno run -A dstCodec.js --to-xml sheetset.dst [--out sheetset.xml]  decode (stdout without --out)
deno run -A dstCodec.js --to-dst sheetset.xml --out sheetset.dst    encode
deno run -A dstCodec.js --sheets sheetset.dst                       one line per sheet
```

Same flags under Node:

```text
node dstCodec.js --to-xml sheetset.dst ...
```

## Portability

`dstCodec.js` is a single dependency-free JavaScript file (JSDoc types, `// @ts-check`, no build step) that runs unmodified in Deno, Node, and browsers.

* **Deno:** `deno run -A dstCodec.js ...` for the CLI, or import the functions directly.
* **Node (v18+):** `node dstCodec.js ...` with the same CLI flags, or import the functions from a Node ESM script.
* **Browser:** use `<script type="module">` and import the pure functions.

The core functions (`dstToXml`, `xmlToDst`, `decodeDst`, `encodeDst`, `dstSheets`) only use standard JavaScript APIs: `TextEncoder`, `TextDecoder`, `Uint8Array`, `RegExp`, and `String`. They have no runtime-specific dependencies.

The CLI is isolated at the bottom of the file and setup so it only runs when the file is actually run as a Deno or Node script; importing the library in a browser skips it.

## Notable references

* [abrman/dst-edit](https://github.com/abrman/dst-edit) - browser-based `.dst` sheet set editor, and the starting point for this project. Its `bit-flip.ts` byte table covers the ASCII range, working out the pattern behind that table gave the block/`PERMUTE` formula above, which extends it to the full 31–254 range.
* [mxwell's `dst_format_ctl.py` gist](https://gist.github.com/mxwell/e253548692820cdce778631165090080) - Python script (2020) that recovers the substitution table by diffing a matching `.xml`/`.dst` pair, one UTF-8 character at a time. Its Cyrillic dictionary was a useful cross-check for the non-ASCII blocks. The cipher turns out to be per-byte rather than per-character, which is why a fixed formula works without paired files.

## License

MIT - see [LICENSE](LICENSE).
