import { expect, test } from "vitest";
import {
  COUNTY,
  DEFAULT_LONG_HELD_YEARS,
  DEFAULT_ROOF_AGE_YEARS,
  LEXICON_MANIFEST_URL,
  PUBLIC_GATEWAYS,
} from "../src/config.ts";

test("county constants", () => {
  expect(COUNTY.fips).toBe("12011");
  expect(COUNTY.dorCountyNo).toBe(16);
  expect(DEFAULT_ROOF_AGE_YEARS).toBe(15);
  expect(DEFAULT_LONG_HELD_YEARS).toBe(10);
  expect(PUBLIC_GATEWAYS).toEqual(["https://ipfs.io", "https://dweb.link"]);
  expect(LEXICON_MANIFEST_URL).toBe("https://lexicon.elephant.xyz/api/manifest");
});

test("kit runtime resolves from the read-only submodule", async () => {
  const mod =
    await import("../vendor/soofi-xyz-team-kit/skills/use-oracle/runtime/src/roof-age/integration.ts");
  expect(typeof mod.applyRoofAgeToTransformedData).toBe("function");
  expect(typeof mod.resolveCanonicalRoofAge).toBe("function");
});
