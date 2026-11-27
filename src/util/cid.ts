import { createHash } from "node:crypto";

/** Multicodec codes for the CIDs this project reads. */
export const CODEC = { raw: 0x55, dagPb: 0x70, dagJson: 0x0129 } as const;
const SHA2_256 = 0x12;

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Decode(s: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`invalid base32 character '${ch}'`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function varint(bytes: Uint8Array, pos: number): [number, number] {
  let x = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[pos++];
    if (b === undefined) throw new Error("truncated varint");
    x += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [x, pos];
    shift += 7;
  }
}

export interface ParsedCid {
  version: 1;
  codec: number;
  hashCode: number;
  digest: Buffer;
}

/** Parse a CIDv1 in base32 (`b…`), the only form Elephant and this project publish. */
export function parseCid(cid: string): ParsedCid {
  if (!/^b[a-z2-7]+$/.test(cid)) throw new Error(`not a base32 CIDv1: ${cid}`);
  const bytes = base32Decode(cid.slice(1));
  const [version, p1] = varint(bytes, 0);
  if (version !== 1) throw new Error(`unsupported CID version ${version}`);
  const [codec, p2] = varint(bytes, p1);
  const [hashCode, p3] = varint(bytes, p2);
  const [len, pos] = varint(bytes, p3);
  const digest = Buffer.from(bytes.subarray(pos, pos + len));
  if (digest.length !== len) throw new Error(`truncated digest in ${cid}`);
  return { version: 1, codec, hashCode, digest };
}

/**
 * True when `bytes` is the block `cid` names: a single-block CID (raw or dag-json, sha2-256)
 * whose digest equals sha256(bytes). Multi-block UnixFS files (dag-pb) are not checkable this
 * way and throw, so callers never mistake "unchecked" for "verified".
 */
export function blockMatchesCid(cid: string, bytes: Uint8Array): boolean {
  const c = parseCid(cid);
  if (c.hashCode !== SHA2_256)
    throw new Error(`unsupported multihash 0x${c.hashCode.toString(16)} in ${cid}`);
  if (c.codec !== CODEC.raw && c.codec !== CODEC.dagJson) {
    throw new Error(`${cid} is not a single-block CID (codec 0x${c.codec.toString(16)})`);
  }
  return createHash("sha256").update(bytes).digest().equals(c.digest);
}
