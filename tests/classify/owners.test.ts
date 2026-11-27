import { expect, test } from "vitest";
import { classifyOccupancy, classifyOwnerLocation, classifyOwnerType } from "../../src/classify/owners.ts";

test("owner location classes", () => {
  expect(classifyOwnerLocation({ state: "FL", zip: "33314" })).toBe("in_county");
  expect(classifyOwnerLocation({ state: "FL", zip: "32801" })).toBe("in_state_out_of_county");
  expect(classifyOwnerLocation({ state: "NY", zip: "10001" })).toBe("out_of_state");
  expect(classifyOwnerLocation({ country: "CANADA" })).toBe("foreign");
  expect(classifyOwnerLocation({})).toBe("unknown");
});

test("owner types", () => {
  expect(classifyOwnerType("ACME HOLDINGS LLC")).toBe("company");
  expect(classifyOwnerType("SMITH JOHN & MARY")).toBe("person");
  expect(classifyOwnerType("SMITH FAMILY TRUST")).toBe("trust");
  expect(classifyOwnerType("BROWARD COUNTY")).toBe("government");
  expect(classifyOwnerType("")).toBe("unknown");
});

test("occupancy classes", () => {
  expect(classifyOccupancy({ landUseCode: "01", homestead: true, ownerType: "person" })).toBe(
    "owner_occupied",
  );
  expect(classifyOccupancy({ landUseCode: "01", homestead: false, ownerType: "company" })).toBe(
    "likely_tenant_occupied",
  );
  expect(classifyOccupancy({ landUseCode: "00", homestead: false, ownerType: "person" })).toBe("vacant_land");
  expect(classifyOccupancy({ landUseCode: null, homestead: null, ownerType: "unknown" })).toBe("unknown");
  expect(classifyOccupancy({ landUseCode: "17", homestead: false, ownerType: "company" })).toBe("commercial");
  expect(classifyOccupancy({ landUseCode: "86", homestead: false, ownerType: "government" })).toBe(
    "government_or_exempt",
  );
});
