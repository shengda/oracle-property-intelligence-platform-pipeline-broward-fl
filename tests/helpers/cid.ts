import { createHash } from "node:crypto";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1, sha2-256, for a codec whose varint is given as bytes. */
export function cidFor(codecVarint: number[], bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest();
  return `b${base32(Uint8Array.from([1, ...codecVarint, 0x12, 0x20, ...digest]))}`;
}
