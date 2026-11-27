import { expect, test } from "vitest";
import {
  classifyRoofWork,
  computeOpenDays,
  lexiconImprovementStatus,
  lexiconImprovementType,
  normalizePermitStatus,
} from "../../src/classify/permits.ts";

test("roof work classes", () => {
  expect(classifyRoofWork({ description: "RE-ROOF SHINGLE 30 SQ" })).toEqual({
    isRoofing: true,
    roofWorkClass: "primary_roof_replacement",
  });
  expect(classifyRoofWork({ description: "ROOF REPAIR 2 SQ" }).roofWorkClass).toBe("repair_or_coating");
  expect(classifyRoofWork({ description: "SCREEN ENCLOSURE ROOF" }).roofWorkClass).toBe("accessory_roof");
  expect(classifyRoofWork({ description: "INTERIOR REMODEL" }).isRoofing).toBe(false);
  expect(classifyRoofWork({ type: "Re-Roof", description: "Re-Roof Permit" }).roofWorkClass).toBe(
    "primary_roof_replacement",
  );
});

test("permit status normalization", () => {
  expect(normalizePermitStatus("Issued")).toBe("open");
  expect(normalizePermitStatus("Finaled")).toBe("completed");
  expect(normalizePermitStatus("Inspections in progress")).toBe("open");
  expect(normalizePermitStatus("Gibberish-Status")).toBe("needs_review");
  expect(normalizePermitStatus(null)).toBe("needs_review");
  expect(normalizePermitStatus("Closed:  Rejected")).toBe("other");
  expect(normalizePermitStatus("Expired")).toBe("other");
  expect(normalizePermitStatus("Complete")).toBe("completed");
});

test("open days", () => {
  expect(computeOpenDays({ status: "open", issuedDate: "2016-03-01" }, "2026-11-25")).toBe(3921);
  expect(computeOpenDays({ status: "open", issuedDate: null }, "2026-11-25")).toBeNull();
  expect(computeOpenDays({ status: "completed", issuedDate: "2016-03-01" }, "2026-11-25")).toBeNull();
  expect(computeOpenDays({ status: "needs_review", issuedDate: "2016-03-01" }, "2026-11-25")).toBeNull();
});

test("Lexicon enums", () => {
  expect(lexiconImprovementStatus("Issued")).toBe("Permitted");
  expect(lexiconImprovementStatus("In Process")).toBe("InProgress");
  expect(lexiconImprovementStatus("Complete")).toBe("Completed");
  expect(lexiconImprovementStatus("Void")).toBe("Cancelled");
  expect(lexiconImprovementStatus("Expired")).toBe("OnHold");
  expect(lexiconImprovementStatus("???")).toBeNull();
  expect(lexiconImprovementType("Re-Roof")).toBe("Roofing");
  expect(lexiconImprovementType("Mechanical")).toBe("MechanicalHVAC");
  expect(lexiconImprovementType("Unknown thing")).toBe("GeneralBuilding");
});
