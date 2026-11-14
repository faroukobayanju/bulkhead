import { describe, expect, test } from "bun:test";
import { bech32, bech32m } from "@scure/base";
import { CHAIN, parsePayee, recipientKey } from "../src/address";

const WPKH_TB = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"; // BIP173
const WSH_TB = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7"; // BIP173
const WPKH_BC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TR_BC = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"; // BIP350
const TR_TB = "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c"; // BIP350
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55 sample
const EVM_MIXED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // EIP-55 sample with lower and upper letters

const words = (n: number, v = 0) => Array.from({ length: n }, (_, i) => (i * 7 + v) % 32);
// version word, then a program of `len` bytes
const segwit = (enc: typeof bech32 | typeof bech32m, hrp: string, version: number, len: number) => enc.encode(hrp, [version, ...enc.toWords(Uint8Array.from({ length: len }, (_, i) => i + 1))]);

describe("tier chains", () => {
  test("tier 1 and 3 are Bitcoin, tier 2 is Base", () => {
    expect(CHAIN).toEqual({ 1: "btc", 2: "evm", 3: "btc" });
  });
});

describe("Bitcoin payee", () => {
  test("accepts P2WPKH, P2WSH and taproot for the network's prefix and returns the lowercase form", () => {
    for (const [a, hrp] of [[WPKH_TB, "tb"], [WSH_TB, "tb"], [TR_TB, "tb"], [WPKH_BC, "bc"], [TR_BC, "bc"]] as const) {
      const p = parsePayee("btc", a, hrp);
      expect(p?.address).toBe(a);
    }
  });

  test("an upper-case address is the same payee, and is normalized to lower case", () => {
    const upper = parsePayee("btc", WPKH_TB.toUpperCase(), "tb")!;
    const lower = parsePayee("btc", WPKH_TB, "tb")!;
    expect(upper.address).toBe(WPKH_TB);
    expect(upper.key).toBe(lower.key);
  });

  test("two different addresses are different payees", () => {
    expect(parsePayee("btc", WPKH_TB, "tb")!.key).not.toBe(parsePayee("btc", WSH_TB, "tb")!.key);
  });

  test("the wrong network's prefix is refused", () => {
    expect(parsePayee("btc", WPKH_BC, "tb")).toBeNull();
    expect(parsePayee("btc", WPKH_TB, "bc")).toBeNull();
    expect(parsePayee("btc", TR_BC, "tb")).toBeNull();
  });

  test("mixed case, a broken checksum, an extra or missing character, and whitespace are refused", () => {
    const mixed = WPKH_TB.slice(0, 10) + WPKH_TB.slice(10).toUpperCase();
    const last = WPKH_TB.slice(-1) === "x" ? "y" : "x";
    for (const a of [mixed, WPKH_TB.slice(0, -1) + last, WPKH_TB + "q", WPKH_TB.slice(0, -1), ` ${WPKH_TB}`, `${WPKH_TB}\n`, WPKH_TB.replace("1", "0"), "", "tb1", "1"]) {
      expect(parsePayee("btc", a, "tb")).toBeNull();
    }
  });

  test("a version 0 address must use bech32, and version 1 must use bech32m", () => {
    expect(parsePayee("btc", segwit(bech32, "tb", 0, 20), "tb")).not.toBeNull();
    expect(parsePayee("btc", segwit(bech32m, "tb", 0, 20), "tb")).toBeNull(); // bech32m checksum on version 0
    expect(parsePayee("btc", segwit(bech32m, "tb", 1, 32), "tb")).not.toBeNull();
    expect(parsePayee("btc", segwit(bech32, "tb", 1, 32), "tb")).toBeNull(); // bech32 checksum on version 1
  });

  test("program lengths: version 0 is 20 or 32 bytes, version 1 is 32", () => {
    expect(parsePayee("btc", segwit(bech32, "tb", 0, 32), "tb")).not.toBeNull();
    for (const len of [0, 1, 19, 21, 31, 33, 40]) expect(parsePayee("btc", segwit(bech32, "tb", 0, len), "tb")).toBeNull();
    for (const len of [20, 31, 33, 40]) expect(parsePayee("btc", segwit(bech32m, "tb", 1, len), "tb")).toBeNull();
  });

  test("witness versions above 1 are refused", () => {
    for (const v of [2, 3, 16]) expect(parsePayee("btc", segwit(bech32m, "tb", v, 32), "tb")).toBeNull();
  });

  test("non-zero padding bits are refused", () => {
    // 20 bytes is 160 bits = 32 words exactly; 33 words leave 5 spare bits, which must be zero
    expect(parsePayee("btc", bech32.encode("tb", [0, ...words(32), 1]), "tb")).toBeNull();
  });

  test("an EVM address, a P2PKH address and junk are refused", () => {
    for (const a of [EVM, EVM.toLowerCase(), "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "not an address"]) {
      expect(parsePayee("btc", a, "tb")).toBeNull();
    }
  });

  test("anything that is not a string is refused", () => {
    for (const a of [undefined, null, 42, {}, [WPKH_TB], { toString: () => WPKH_TB }]) expect(parsePayee("btc", a, "tb")).toBeNull();
  });

  test("a very long string is refused without being decoded", () => {
    expect(parsePayee("btc", "tb1" + "q".repeat(5000), "tb")).toBeNull();
  });
});

describe("EVM payee", () => {
  test("accepts a checksummed address unchanged", () => {
    expect(parsePayee("evm", EVM, "tb")?.address).toBe(EVM);
    expect(parsePayee("evm", EVM_MIXED, "tb")?.address).toBe(EVM_MIXED);
  });

  test("an all-lowercase address is normalized to EIP-55 (E9)", () => {
    const p = parsePayee("evm", EVM_MIXED.toLowerCase(), "tb")!;
    expect(p.address).toBe(EVM_MIXED);
    expect(p.key).toBe(parsePayee("evm", EVM_MIXED, "tb")!.key);
  });

  test("mixed case with a wrong checksum is refused, not silently re-cased", () => {
    expect(parsePayee("evm", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd", "tb")).toBeNull(); // the last letter's case flipped
  });

  test("wrong length, missing or upper-case 0x, whitespace and non-hex are refused", () => {
    const hex = EVM_MIXED.slice(2).toLowerCase();
    for (const a of ["0x" + hex.slice(1), "0x" + hex + "0", hex, "0X" + hex, ` 0x${hex}`, `0x${hex} `, "0x" + "g".repeat(40), "", "0x"]) {
      expect(parsePayee("evm", a, "tb")).toBeNull();
    }
  });

  test("a Bitcoin address, and anything that is not a string, are refused", () => {
    for (const a of [WPKH_TB, WPKH_BC, undefined, null, 42, {}, [EVM]]) expect(parsePayee("evm", a, "tb")).toBeNull();
  });
});

describe("recipientKey (the model's string, compared and never sent)", () => {
  test("Bitcoin keys match for the same decoded address in any case, and differ for another", () => {
    expect(recipientKey("btc", WPKH_TB.toUpperCase(), "tb")).toBe(parsePayee("btc", WPKH_TB, "tb")!.key);
    expect(recipientKey("btc", WSH_TB, "tb")).not.toBe(parsePayee("btc", WPKH_TB, "tb")!.key);
    expect(recipientKey("btc", WPKH_BC, "tb")).toBeNull();
    expect(recipientKey("btc", EVM, "tb")).toBeNull();
    expect(recipientKey("btc", 5, "tb")).toBeNull();
  });

  test("EVM keys ignore case entirely, even a wrong checksum, but need the 0x shape", () => {
    const key = parsePayee("evm", EVM_MIXED, "tb")!.key;
    expect(recipientKey("evm", EVM_MIXED, "tb")).toBe(key);
    expect(recipientKey("evm", EVM_MIXED.toLowerCase(), "tb")).toBe(key);
    expect(recipientKey("evm", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd", "tb")).toBe(key);
    for (const a of [WPKH_TB, EVM_MIXED.slice(2), EVM_MIXED + "0", ` ${EVM_MIXED}`, "0X" + EVM_MIXED.slice(2), 7, null]) expect(recipientKey("evm", a, "tb")).toBeNull();
  });
});
