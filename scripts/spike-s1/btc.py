"""Spike S1 helper, pure stdlib: the Bitcoin tier address from a v1.signer derived
key, and witness assembly for a contract-signed one-input P2WPKH payout.

  python3 btc.py addr <secp256k1:base58 key from derived_public_key> [hrp]
  python3 btc.py assemble <unsigned_tx_hex> <big_r hex> <s hex> <recovery_id> <secp256k1:base58 key> <sighash hex>
"""
import hashlib
import sys

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw


def near_key_point(key):
    raw = b58decode(key.split(":", 1)[1])
    assert len(raw) == 64, len(raw)  # x || y, no 0x04 prefix
    x, y = int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")
    assert (y * y - x * x * x - 7) % P == 0, "not on secp256k1"
    return x, y


def compressed(pt):
    return bytes([2 + (pt[1] & 1)]) + pt[0].to_bytes(32, "big")


def hash160(b):
    return hashlib.new("ripemd160", hashlib.sha256(b).digest()).digest()


# BIP-173 reference bech32 (witness v0 uses bech32, not bech32m)
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def polymod(values):
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk


def hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def convertbits(data, frm, to):
    acc = bits = 0
    out = []
    for v in data:
        acc = (acc << frm) | v
        bits += frm
        while bits >= to:
            bits -= to
            out.append((acc >> bits) & ((1 << to) - 1))
    if bits:
        out.append((acc << (to - bits)) & ((1 << to) - 1))
    return out


def segwit_v0_addr(hrp, program):
    data = [0] + convertbits(program, 8, 5)
    pm = polymod(hrp_expand(hrp) + data + [0] * 6) ^ 1
    checksum = [(pm >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[d] for d in data + checksum)


# minimal secp256k1 for verifying the MPC signature before broadcast
def add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0:
        return None
    if a == b:
        lam = 3 * a[0] * a[0] * pow(2 * a[1], -1, P) % P
    else:
        lam = (b[1] - a[1]) * pow(b[0] - a[0], -1, P) % P
    x = (lam * lam - a[0] - b[0]) % P
    return x, (lam * (a[0] - x) - a[1]) % P


def mul(k, pt):
    r = None
    while k:
        if k & 1:
            r = add(r, pt)
        pt = add(pt, pt)
        k >>= 1
    return r


def verify(z, r, s, pub):
    w = pow(s, -1, N)
    pt = add(mul(z * w % N, G), mul(r * w % N, pub))
    return pt is not None and pt[0] % N == r


def der(r, s):
    def i(v):
        b = v.to_bytes(32, "big").lstrip(b"\0")
        return b"\x00" + b if b[0] & 0x80 else b
    rb, sb = i(r), i(s)
    body = b"\x02" + bytes([len(rb)]) + rb + b"\x02" + bytes([len(sb)]) + sb
    return b"\x30" + bytes([len(body)]) + body


def varint(n):
    assert n < 0xFD
    return bytes([n])


def assemble(unsigned_hex, big_r_hex, s_hex, key, sighash_hex):
    """Legacy-layout unsigned tx (1 in) -> segwit tx with witness [sig||01, pubkey]."""
    pub = near_key_point(key)
    big_r = bytes.fromhex(big_r_hex)
    r = int.from_bytes(big_r[1:33], "big")
    s = int.from_bytes(bytes.fromhex(s_hex), "big")
    z = int.from_bytes(bytes.fromhex(sighash_hex), "big")
    assert verify(z, r, s, pub), "signature does not verify against the tier key"
    tx = bytes.fromhex(unsigned_hex)
    version, rest, locktime = tx[:4], tx[4:-4], tx[-4:]
    sig = der(r, s) + b"\x01"  # SIGHASH_ALL
    cpub = compressed(pub)
    witness = varint(2) + varint(len(sig)) + sig + varint(len(cpub)) + cpub
    return (version + b"\x00\x01" + rest + witness + locktime).hex()


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "addr":
        hrp = sys.argv[3] if len(sys.argv) > 3 else "tb"
        pt = near_key_point(sys.argv[2])
        print("compressed_pubkey", compressed(pt).hex())
        print("address", segwit_v0_addr(hrp, hash160(compressed(pt))))
    elif cmd == "assemble":
        print(assemble(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[6], sys.argv[7]))
