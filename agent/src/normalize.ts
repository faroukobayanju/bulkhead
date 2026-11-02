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
// The tool name is matched on letters alone, so spacing, punctuation and junk between its letters ("release - funds",
// "r e l e a s e f u n d s", "release_ funds") cannot hide it. Runs after clean(), so confusables are already folded.
// Known false-positive class: adjacent words that spell it across a boundary ("press release. Funds raised", "more lease funds").
const TOOL_LETTERS = "releasefunds";
const mentions = (s: string) => s.replace(/[^A-Za-z]/g, "").toLowerCase().includes(TOOL_LETTERS);
// [start, end) of the first mention in `s`, for cutting a bounded segment around it.
function toolSpan(s: string): [number, number] | null {
  const letters: string[] = [], at: number[] = [];
  for (const m of s.matchAll(/[A-Za-z]/g)) { letters.push(m[0].toLowerCase()); at.push(m.index); }
  const k = letters.join("").indexOf(TOOL_LETTERS);
  return k < 0 ? null : [at[k]!, at[k + TOOL_LETTERS.length - 1]! + 1];
}
// Bounded segment (64 chars before, 128 after) around the first mention in `s`; `s` itself must mention the tool.
const around = (s: string) => {
  const [a, b] = toolSpan(s)!;
  return s.slice(Math.max(0, a - 64), b + 128);
};

const MAX_DEPTH = 2; // decoding layers: base64(rot13(x)) and base64(base64(x)) are seen, three layers are not
const MAX_DECODED = 16; // entries returned; tool-name hits are kept first so decoys cannot push them out
// The serialized result must fit the 16 KB firewall body limit even though NFKC can expand input 18x:
// 8192 (text) + 16 * (448 + 32 entry overhead) + 128 (keys, flags) = 16000 <= 16384. Sizes are JSON UTF-8 bytes.
const MAX_TEXT_BYTES = 8192;
const MAX_VALUE_BYTES = 448;

type Decoded = { kind: "base64" | "hex" | "morse" | "rot13" | "tags"; value: string };

const REPLACEMENT = "\uFFFD";
// Control characters other than tab/newline/CR.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g;
const PLAIN = /^[\t\n\r\x20-\x7E]+$/; // printable ASCII plus tab/newline/CR
// Junk in a lenient decode: replacement characters (invalid UTF-8) and control characters.
const GARBAGE = /[\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/;

const readable = (s: string) => s.length >= 8 && (s.match(/[A-Za-z ]/g)?.length ?? 0) / s.length >= 0.6;

// Bytes one code point takes in JSON.stringify output: quotes/backslashes and control chars are escaped,
// lone surrogates become 6-byte escapes.
const jsonBytes = (cp: number) =>
  cp === 34 || cp === 92 ? 2 : cp < 32 || (cp >= 0xd800 && cp < 0xe000) ? 6 : cp < 128 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
function clip(s: string, budget: number) {
  let used = 0, end = 0;
  for (const c of s) {
    used += jsonBytes(c.codePointAt(0)!);
    if (used > budget) break;
    end += c.length;
  }
  return s.slice(0, end);
}

const fold = (s: string) => s.replace(CONFUSABLE, c => CONFUSABLES[c]!);
const clean = (s: string) => fold(s.replace(INVISIBLE, "").normalize("NFKC"));

// NFKC turned a non-ASCII char into one ASCII letter (fullwidth, math-bold, circled...). Not "\u2026" -> "..." or "\u2122" -> "TM".
const lettersChanged = (s: string) =>
  [...s].some(c => c > "\x7f" && /^[A-Za-z]$/.test(c.normalize("NFKC")));

function rot13(s: string) {
  return s.replace(/[a-z]/gi, c => String.fromCharCode((c <= "Z" ? 65 : 97) + ((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26)));
}

type Candidate = Decoded & { report: boolean };

// One decoding layer of `raw`. Values are raw decodes (invalid UTF-8 becomes replacement characters); callers clean them.
// `report: false` marks decodes that are only worth recursing into.
function layer(raw: string): Candidate[] {
  const out: Candidate[] = [];
  const add = (kind: Decoded["kind"], value: string, report = true) => out.push({ kind, value, report });
  const text = clean(raw);

  // Tag characters mirror printable ASCII at +0xE0000.
  const tags = [...raw].map(c => c.codePointAt(0)! - 0xe0000).filter(n => n >= 0x20 && n <= 0x7e).map(n => String.fromCharCode(n)).join("");
  if (tags) add("tags", tags);

  // base64: tokens of 4+ alphabet chars, rejoined across whitespace. Prose words can sit in front of the payload and
  // shift its alignment, so decode the run at all four offsets; garbage around the payload turns into replacement
  // characters and readable()/mentions() decide. The `*` form always matches at its first token, so scanning stays linear.
  // The run may end in a short tail token (a padded final chunk like "cw=="); no other token under 4 chars joins it.
  // Each 16+ char token is also decoded alone, so a lone payload beside a prose word survives the word's junk.
  for (const m of text.match(/[A-Za-z0-9+/]{4,}(?:\s+[A-Za-z0-9+/]{4,})*(?:\s+[A-Za-z0-9+/]{1,3})?={0,2}/g) ?? []) {
    const joined = m.replace(/\s+/g, "");
    if (joined.length >= 16) for (let o = 0; o < 4; o++) add("base64", Buffer.from(joined.slice(o), "base64").toString());
    const tokens = m.split(/\s+/);
    if (tokens.length > 1) for (const t of tokens) if (t.length >= 16) add("base64", Buffer.from(t, "base64").toString());
  }

  // hex: glued, whitespace/comma separated, 0x- or backslash-x prefixed. Separators and prefixes never overlap the digits,
  // so matching stays linear. A word ending in hex letters ("de" of "decode") can join the run: the lenient decode turns
  // that byte into a replacement character, and a glued run is also tried one digit in (odd-length prefix such as "bad").
  for (const m of text.match(/(?:(?:0x|\\x)?[0-9a-fA-F]{2}[\s,]*){8,}[0-9a-fA-F]?/g) ?? []) {
    const core = m.replace(/[\s,]+$/, "");
    const glued = /^[0-9a-fA-F]+$/.test(core);
    const hex = glued ? core : m.match(/[0-9a-fA-F]{2}/g)!.join("");
    // Decimal lists ("45 62 71 ...") read as hex spell letters, so unprefixed digits-only hex is recursed into (hex of hex)
    // but never reported. Payloads that spell the tool name always contain an a-f digit (the 'l' in "release" is 0x6c).
    // The first byte of a separated run may be a prose word ("de" of "decode"), so it does not count towards the a-f rule.
    const report = /[a-fA-F]/.test(glued ? hex : hex.slice(2)) || (m.match(/x/g)?.length ?? 0) * 2 === hex.length;
    for (const o of glued ? [0, 1] : [0]) add("hex", Buffer.from(hex.slice(o), "hex").toString(), report);
  }

  for (const m of text.match(/(?:[.\-]{1,5}(?:\s+|\s*\/\s*)){3,}[.\-]{1,5}/g) ?? []) {
    add("morse", m.trim().split(/\s*\/\s*/).map(w => w.split(/\s+/).map(c => MORSE[c] ?? "").join("")).join(" "));
  }
  // Only the segment around the hit, not the whole message (which NFKC may have expanded).
  const r = rot13(text);
  if (mentions(r) && !mentions(text)) add("rot13", around(r));
  return out;
}

// The parts of one (cleaned) decode worth reporting.
// - No U+FFFD means valid UTF-8, so any control bytes were put there on purpose (to break words or the tool name):
//   judge the whole value, reporting it with control runs collapsed to a space and, if that differs, with them removed
//   (so "prev<ctrl>ious" is also readable as "previous"). Short non-ASCII decodes are not reported (noise passes
//   readable() often enough to bury real signals).
// - U+FFFD means invalid bytes, usually a misaligned prefix: judge the stretches between the junk, which must name the
//   tool or be 16+ chars of plain readable ASCII. If junk splits the tool name itself, report a segment around it.
function reportable(value: string): string[] {
  // readable() judges the value as decoded, control bytes counting against it: collapsing them to spaces first would
  // turn noise full of control bytes into "readable" text (random 16-char tokens did, about 1 in 10,000).
  const ok = (v: string) => mentions(v) || (readable(value) && (PLAIN.test(v) || v.length >= 16));
  if (!value.includes(REPLACEMENT)) {
    const spaced = value.replace(CONTROL, " "), stripped = value.replace(CONTROL, "");
    return (stripped === spaced ? [spaced] : [spaced, stripped]).filter(ok);
  }
  const parts = value.split(GARBAGE).filter(f => mentions(f) || (f.length >= 16 && PLAIN.test(f) && readable(f)));
  if (!mentions(value) || parts.some(mentions)) return parts;
  return [around(value.split(GARBAGE).join("")), ...parts];
}

// Recurse into every decoded layer, readable or not (a hex or base64 string wrapping the real payload is unreadable).
// Work stays O(input): each layer's decodes together are a constant factor of the layer, and depth is capped.
function collect(raw: string, depth: number, out: Decoded[]) {
  for (const c of layer(raw)) {
    if (c.report) for (const value of reportable(clean(c.value))) out.push({ kind: c.kind, value });
    if (depth + 1 < MAX_DEPTH) collect(c.value, depth + 1, out);
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
  const tool = new Set(all.filter(d => mentions(d.value)));
  if (mentions(text) || tool.size) flags.add("tool_name_mention");

  // Flags above saw the full values; only now clip what leaves this function.
  const clippedText = clip(text, MAX_TEXT_BYTES);
  if (clippedText.length < text.length) flags.add("truncated");

  const decoded = all
    .sort((a, b) => Number(tool.has(b)) - Number(tool.has(a)))
    .slice(0, MAX_DECODED)
    .map(d => ({ kind: d.kind, value: clip(d.value, MAX_VALUE_BYTES) }));
  return { text: clippedText, decoded, flags: [...flags] };
}
