// @ts-check
// dst-codec — read and write AutoCAD/ARES Commander Sheet Set (*.dst) files.
//
// .dst files contain UTF-8 XML encoded with a fixed byte-substitution cipher.
// The encoding is byte-for-byte: each dst byte is split into a 4-bit block
// and a 4-bit index, then mapped to an XML byte:
//
//     xml = BLOCK_BASE[dst >> 4] + PERMUTE[dst & 0xF]
//
// The same 16-entry permutation is used for every block.
//
// The tables below describe the observed encoding. Some block/index
// combinations are formula-valid but do not occur in real .dst files as far as I know.

/** One fixed 16-entry permutation of the low nibble, identical across every block. */
const PERMUTE = [13, 12, 15, 14, 9, 8, 11, 10, 5, 4, 7, 6, 1, 0, 3, 2];

// block  dst range    xml range   coverage
// 0x0    0-15         127-142     full (dst 13 -> xml 127 DEL can never be typed, see README)
// 0x1    16-31        111-126     full — lowercase o-z, plus { | } ~
// 0x2    32-47        159-174     full — å ä é ü ñ ö and the rest of Latin-1 Supplement
// 0x3    48-63        143-158     full
// 0x4    64-79        191-206     full — ö's lead byte and 3 more 2-byte UTF-8 lead bytes
// 0x5    80-95        175-190     full
// 0x6    96-111       223-238     full — 3-byte lead bytes: Devanagari 0xE0, CJK 0xE4-0xE7
// 0x7    112-127      207-222     full — Greek/Cyrillic/Armenian/Hebrew/Arabic lead bytes
// 0x9    144-159      239-254     full — an emoji's 4-byte lead byte 0xF0
// 0xa    160-175      31-46       full — punctuation & XML syntax (& " ' ( ) etc.)
// 0xc    192-207      63-78       full
// 0xd    208-223      47-62       full — includes <
// 0xe    224-239      95-110      full
// 0xf    240-255      79-94       full
/** @type {Readonly<Record<number, number>>} */
const BLOCK_BASE = {
    0x0: 127, 0x1: 111, 0x2: 159, 0x3: 143, 0x4: 191, 0x5: 175, 0x6: 223, 0x7: 207, 0x9: 239,
    0xa: 31, 0xc: 63, 0xd: 47, 0xe: 95, 0xf: 79,
};

// TAB/LF: ARES writes dst 135 for LF and 134 for TAB, and uses pretty-printed XML.
// AutoCAD file writes dst 131 for LF instead..
// Decode accepts both 131 and 135 as LF.
// For encode I decided to use 131 (AutoCAD) not 135 (ARES), I know ARES accepts both, but no idea on AutoCAD, so playing it safe.
/** @type {Readonly<Record<number, number>>} */
const WHITESPACE_DST_TO_XML = { 131: 10, 134: 9, 135: 10 };
const LF_DST = 131;
const TAB_DST = 134;

/**
 * One .dst byte -> the XML byte it decodes to, or `undefined` if this byte is not yet confirmed.
 * @param {number} byte
 * @returns {number|undefined}
 */
export function dstToXml(byte){
    const w = WHITESPACE_DST_TO_XML[byte];
    if(w !== undefined) return w;
    const base = BLOCK_BASE[byte >> 4];
    return base === undefined ? undefined : base + PERMUTE[byte & 0xF];
}

// PERMUTE is self-inverse
/** @type {Readonly<Record<number, number>>} */
const XML_TO_DST = (() => {
    /** @type {Record<number, number>} */
    const rev = {};
    for(let b = 0; b < 256; b++){
        const x = dstToXml(b);
        if(x !== undefined && !(x in rev)) rev[x] = b;
    }
    rev[9]  = TAB_DST;
    rev[10] = LF_DST;   // both 131 and 135 decode to LF.
    return rev;
})();

/**
 * The XML byte a .dst byte encodes to, or `undefined` if this XML byte is not yet reachable.
 * @param {number} byte
 * @returns {number|undefined}
 */
export function xmlToDst(byte){
    return XML_TO_DST[byte];
}

/**
 * @param {Uint8Array} src
 * @param {(b: number) => number|undefined} map
 * @param {string} what
 * @returns {Uint8Array}
 */
function substitute(src, map, what){
    const out = new Uint8Array(src.length);
    for(let i = 0; i < src.length; i++){
        const m = map(src[i]);
        if(m === undefined){
            throw new Error(
                `${what}: byte 0x${src[i].toString(16)} at offset ${i} is in a block this codec ` +
                `doesn't have a confirmed base for yet (see the block table above BLOCK_BASE in ` +
                `dstCodec.js, or README.md).`,
            );
        }
        out[i] = m;
    }
    return out;
}

/**
 * .dst bytes -> XML text (entities such as `&amp;` are left intact, not unescaped).
 * @param {Uint8Array} dst
 * @returns {string}
 */
export function decodeDst(dst){
    return new TextDecoder("utf-8", { fatal: true }).decode(substitute(dst, dstToXml, "decodeDst"));
}

/**
 * XML text -> .dst bytes.
 *
 * Line endings are normalised to LF first. CR has no .dst byte, and XML parsers normalise
 * CRLF / CR to LF on read anyway, so nothing is lost. CRLF shows up in practice from XML files
 * saved on Windows and from Firefox's XMLSerializer, which writes CRLF after the XML declaration.
 * @param {string} xml
 * @returns {Uint8Array}
 */
export function encodeDst(xml){
    return substitute(new TextEncoder().encode(xml.replace(/\r\n?/g, "\n")), xmlToDst, "encodeDst");
}

/**
 * @typedef {Object} DstSheet
 * @property {string} id       AcSmSheet ID (GUID-ish, "g…")
 * @property {string} number   sheet number, e.g. "E921"
 * @property {string} title
 * @property {string} file     Relative_FileName of the layout, e.g. ".\3-Wiring.dwg"
 * @property {string} fileAbs  FileName (absolute) as stored
 * @property {string} handle   AcDbHandle of the layout in that DWG — this is what ARES resolves by
 * @property {string} layout   layout Name as stored (can be stale; the handle wins)
 * @property {boolean} plot    false when DoNotPlot is set
 */

/** @param {string} s @returns {string} */
const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/**
 * Sheets in document order, should be the same as the order the Sheet Set Manager shows and publishes.
 * @param {string} xml
 * @returns {DstSheet[]}
 */
export function dstSheets(xml){
    /** @param {string} block @param {string} name @returns {string} */
    const prop = (block, name) => unesc(block.match(new RegExp(`<AcSmProp propname="${name}"[^>]*>([^<]*)</AcSmProp>`))?.[1] ?? "");
    /** @type {DstSheet[]} */
    const out = [];
    for(const m of xml.matchAll(/<AcSmSheet\b[^>]*\bID="([^"]+)"[^>]*>([\s\S]*?)<\/AcSmSheet>/g)){
        const body = m[2];
        const layout = body.match(/<AcSmAcDbLayoutReference[\s\S]*?<\/AcSmAcDbLayoutReference>/)?.[0] ?? "";
        out.push({
            id: m[1],
            number: prop(body, "Number"),
            title: prop(body, "Title"),
            file: prop(layout, "Relative_FileName"),
            fileAbs: prop(layout, "FileName"),
            handle: prop(layout, "AcDbHandle"),
            layout: prop(layout, "Name"),
            plot: prop(body, "DoNotPlot") !== "-1",
        });
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// CLI — runs under Deno or Node when this file is run directly. Does nothing if imported as a library, or loaded in a browser
// ---------------------------------------------------------------------------------------------

const CLI_USAGE = `dst-codec CLI.

  deno run -A dstCodec.js --to-xml <file.dst> [--out <file.xml>]   decode (prints to stdout without --out)
  deno run -A dstCodec.js --to-dst <file.xml> --out <file.dst>     encode
  deno run -A dstCodec.js --sheets <file.dst>                      one line per sheet: number, file, layout handle, title

  (Node: run the same commands with "node dstCodec.js" instead of "deno run -A dstCodec.js".)`;

/**
 * @typedef {Object} CliArgs
 * @property {string} [to-xml]
 * @property {string} [to-dst]
 * @property {string} [sheets]
 * @property {string} [out]
 * @property {boolean} [help]
 */

/**
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseCliArgs(argv){
    /** @type {CliArgs} */
    const args = {};
    for(let i = 0; i < argv.length; i++){
        const a = argv[i];
        if(a === "--help" || a === "-h"){ args.help = true; continue; }
        if(a === "--to-xml" || a === "--to-dst" || a === "--sheets" || a === "--out"){
            args[/** @type {"to-xml"|"to-dst"|"sheets"|"out"} */ (a.slice(2))] = argv[++i];
        }
    }
    return args;
}

/**
 * @typedef {Object} CliIo
 * @property {(path: string) => Promise<Uint8Array>} readFile
 * @property {(path: string, data: Uint8Array) => Promise<void>} writeFile
 * @property {(path: string) => Promise<string>} readTextFile
 * @property {(path: string, text: string) => Promise<void>} writeTextFile
 * @property {(code: number) => void} exit
 * @property {(msg: string) => void} log
 * @property {(msg: string) => void} error
 *
 * @param {string[]} argv
 * @param {CliIo} io
 */
async function runCli(argv, io){
    const args = parseCliArgs(argv);
    if(args.help || !(args["to-xml"] || args["to-dst"] || args.sheets)){
        io.log(CLI_USAGE);
        io.exit(args.help ? 0 : 2);
        return;
    }
    if(args["to-xml"]){
        const xml = decodeDst(await io.readFile(args["to-xml"]));
        if(args.out) await io.writeTextFile(args.out, xml); else io.log(xml);
    }
    if(args["to-dst"]){
        if(!args.out){ io.error("--to-dst needs --out <file.dst>"); io.exit(2); return; }
        await io.writeFile(args.out, encodeDst(await io.readTextFile(args["to-dst"])));
    }
    if(args.sheets){
        for(const s of dstSheets(decodeDst(await io.readFile(args.sheets)))){
            io.log(`${s.number.padEnd(10)} ${s.file.padEnd(16)} h=${s.handle.padEnd(6)} ${s.plot ? "" : "[no plot]"} ${s.title}`);
        }
    }
}

// Deno entry point. Only reached when this file is the script Deno ran directly.
if(typeof Deno !== "undefined" && import.meta.main){
    await runCli(Deno.args, {
        readFile:      (p)    => Deno.readFile(p),
        writeFile:     (p, d) => Deno.writeFile(p, d),
        readTextFile:  (p)    => Deno.readTextFile(p),
        writeTextFile: (p, t) => Deno.writeTextFile(p, t),
        exit:          (c)    => Deno.exit(c),
        log:           (m)    => console.log(m),
        error:         (m)    => console.error(m),
    });
} else if(typeof process !== "undefined" && process.versions && process.versions.node){
    // Node entry point. node:url is needed to tell whether this file is being ran directly, or if it's being imported.
    const { fileURLToPath } = await import("node:url");
    const invokedDirectly = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
    if(invokedDirectly){
        const fs = await import("node:fs/promises");
        await runCli(process.argv.slice(2), {
            readFile:      (p)    => fs.readFile(p),
            writeFile:     (p, d) => fs.writeFile(p, d),
            readTextFile:  (p)    => fs.readFile(p, "utf-8"),
            writeTextFile: (p, t) => fs.writeFile(p, t, "utf-8"),
            exit:          (c)    => process.exit(c),
            log:           (m)    => console.log(m),
            error:         (m)    => console.error(m),
        });
    }
}
