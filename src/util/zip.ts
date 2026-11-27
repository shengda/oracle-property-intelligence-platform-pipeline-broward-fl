import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Minimal deterministic ZIP writer (Deflate or STORE, fixed timestamps).
 * One ZIP per property keeps a 766k-property group to ~3 GB on disk instead of ~4.4 M tiny files,
 * and identical inputs always produce byte-identical archives.
 */
export function buildZip(
  files: { name: string; data: Buffer | string }[],
  opts: { deflate?: boolean } = {},
): Buffer {
  const deflate = opts.deflate ?? true;
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00:00 in DOS format.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const f of sorted) {
    const name = Buffer.from(f.name, "utf8");
    const data = typeof f.data === "string" ? Buffer.from(f.data, "utf8") : f.data;
    const crc = crc32(data) >>> 0;
    const body = deflate ? deflateRawSync(data, { level: 6 }) : data;
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Read a ZIP written by `buildZip` (STORE or Deflate entries). */
export function readZip(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    if (method !== 0 && method !== 8) throw new Error(`readZip: unsupported method ${method}`);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const start = p + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + size);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
    p = start + size;
  }
  return out;
}
