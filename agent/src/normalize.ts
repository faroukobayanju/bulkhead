// Input normalizer: the first stage of the AI firewall. Everything here treats `input` as attacker-controlled.

// Invisible characters: soft hyphen, Mongolian vowel separator, zero-width/joiner/bidi marks (U+200B-200F),
// bidi embeddings/overrides (U+202A-202E), word joiner & invisible operators (U+2060-2064),
// bidi isolates (U+2066-2069), BOM, and Unicode tag characters (U+E0000-E007F).
const INVISIBLE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

// Cyrillic/Greek lookalikes that NFKC leaves alone, folded to the Latin letter they imitate.
const CONFUSABLES: Record<string, string> = {
  // Cyrillic lowercase
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x",
  "\u0443": "y", "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04BB": "h",
  // Cyrillic uppercase
  "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K", "\u041C": "M", "\u041D": "H",
  "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u0406": "I",
  // Greek
  "\u03BF": "o", "\u03BD": "v", "\u03C1": "p", "\u03B9": "i",
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u039A": "K",
  "\u039C": "M", "\u039D": "N", "\u039F": "O", "\u03A1": "P", "\u03A4": "T", "\u03A7": "X",
};
const CONFUSABLE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

const MORSE: Record<string, string> = {
  ".-":"A","-...":"B","-.-.":"C","-..":"D",".":"E","..-.":"F","--.":"G","....":"H","..":"I",".---":"J","-.-":"K",".-..":"L","--":"M",
  "-.":"N","---":"O",".--.":"P","--.-":"Q",".-.":"R","...":"S","-":"T","..-":"U","...-":"V",".--":"W","-..-":"X","-.--":"Y","--..":"Z",
  "-----":"0",".----":"1","..---":"2","...--":"3","....-":"4",".....":"5","-....":"6","--...":"7","---..":"8","----.":"9",
};
const TOOL = /release[\s_-]?funds/i;

const MAX_DEPTH = 2; // decoding layers: base64(rot13(x)) and base64(base64(x)) are seen, three layers are not
const MAX_DECODED = 16; // entries returned; tool-name hits are kept first so decoys cannot push them out

type Decoded = { kind: "base64" | "hex" | "morse" | "rot13" | "tags"; value: string };

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const utf8 = (b: Uint8Array) => {
  try { return UTF8.decode(b); } catch { return null; } // garbage bytes are not a payload
};

const readable = (s: string) => s.length >= 8 && (s.match(/[A-Za-z ]/g)?.length ?? 0) / s.length >= 0.6;

const fold = (s: string) => s.replace(CONFUSABLE, c => CONFUSABLES[c]!);
const clean = (s: string) => fold(s.replace(INVISIBLE, "").normalize("NFKC"));

// NFKC turned a non-ASCII char into one ASCII letter (fullwidth, math-bold, circled...). Not "\u2026" -> "..." or "\u2122" -> "TM".
const lettersChanged = (s: string) =>
  [...s].some(c => c > "\x7f" && /^[A-Za-z]$/.test(c.normalize("NFKC")));

function rot13(s: string) {
  return s.replace(/[a-z]/gi, c => String.fromCharCode((c <= "Z" ? 65 : 97) + ((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26)));
}

// One decoding layer of `raw`. Values are raw decodes; callers clean them.
function layer(raw: string): Decoded[] {
  const out: Decoded[] = [];
  const add = (kind: Decoded["kind"], value: string | null) => value !== null && out.push({ kind, value });
  const text = clean(raw);

  // Tag characters mirror printable ASCII at +0xE0000.
  const tags = [...raw].map(c => c.codePointAt(0)! - 0xe0000).filter(n => n >= 0x20 && n <= 0x7e).map(n => String.fromCharCode(n)).join("");
  if (tags) add("tags", tags);
  for (const m of text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) add("base64", utf8(Buffer.from(m, "base64")));
  for (const m of text.match(/(?:0x)?(?:[0-9a-fA-F]{2}){8,}/g) ?? []) add("hex", utf8(Buffer.from(m.replace(/^0x/, ""), "hex")));
  for (const m of text.match(/(?:[.\-]{1,5}(?:\s+|\s*\/\s*)){3,}[.\-]{1,5}/g) ?? []) {
    add("morse", m.trim().split(/\s*\/\s*/).map(w => w.split(/\s+/).map(c => MORSE[c] ?? "").join("")).join(" "));
  }
  const r = rot13(text);
  if (TOOL.test(r) && !TOOL.test(text)) add("rot13", r);
  return out;
}

// Recurse into every decoded layer (even unreadable ones, e.g. a hex or base64 string wrapping the real payload).
// Work stays O(input): each layer's decodes together are no longer than the layer, and depth is capped.
function collect(raw: string, depth: number, out: Decoded[]) {
  for (const d of layer(raw)) {
    const value = clean(d.value);
    if (readable(value) || TOOL.test(value)) out.push({ kind: d.kind, value }); // digit-padding must not hide the tool name
    if (depth + 1 < MAX_DEPTH) collect(d.value, depth + 1, out);
  }
}

export function normalize(input: string) {
  const flags = new Set<string>();
  if (input.search(INVISIBLE) >= 0) flags.add("zero_width"); // not .test: a /g regex keeps lastIndex across calls
  const stripped = input.replace(INVISIBLE, "");
  const nfkc = stripped.normalize("NFKC");
  const text = fold(nfkc);
  if (text !== nfkc || lettersChanged(stripped)) flags.add("homoglyph");

  const all: Decoded[] = [];
  collect(input, 0, all);
  if (all.length) flags.add("encoded_payload");
  if (TOOL.test(text) || all.some(d => TOOL.test(d.value))) flags.add("tool_name_mention");

  const decoded = all.sort((a, b) => Number(TOOL.test(b.value)) - Number(TOOL.test(a.value))).slice(0, MAX_DECODED);
  return { text, decoded, flags: [...flags] };
}
