import { expect, test } from "vitest";
import { blockMatchesCid, CODEC, parseCid } from "../../src/util/cid.ts";
import { cidFor } from "../helpers/cid.ts";

test("parses a real Atlas CountyTables CID as dag-json, sha2-256", () => {
  const c = parseCid("baguqeerax3xfuzyicaa6nl6djisjqpyajpm7ymhizkvi4qqznsry4ur6tlta");
  expect(c.codec).toBe(CODEC.dagJson);
  expect(c.hashCode).toBe(0x12);
  expect(c.digest).toHaveLength(32);
});

test("a dag-json block matches its CID; one changed byte does not", () => {
  const block = Buffer.from('{"label":"CountyTables"}');
  const cid = cidFor([0xa9, 0x02], block);
  expect(cid.startsWith("baguqeera")).toBe(true);
  expect(blockMatchesCid(cid, block)).toBe(true);
  expect(blockMatchesCid(cid, Buffer.from('{"label":"CountyTablez"}'))).toBe(false);
});

test("raw blocks are checkable; multi-block UnixFS (dag-pb) CIDs are refused, not passed", () => {
  const block = Buffer.from("hello");
  expect(blockMatchesCid(cidFor([0x55], block), block)).toBe(true);
  expect(() => blockMatchesCid("bafybeihx4cijrkr4qhasuz5nw7qu3izmwdoj4utgumpocnnt7ingg3ykxu", block)).toThrow(
    /not a single-block CID/,
  );
  expect(() => parseCid("Qmabc")).toThrow(/base32 CIDv1/);
});
