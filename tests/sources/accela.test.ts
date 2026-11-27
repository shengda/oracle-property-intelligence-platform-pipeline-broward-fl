import { expect, test } from "vitest";
import { parseAccelaDetail } from "../../src/sources/accela-ftl.ts";

const html = `<div><span class="ACA_SmLabel">Record Status:</span>&nbsp;<span id="ctl00_status">Issued</span></div>
<h1>Licensed Professional:</h1><table><tr><td>JANE Q ROOFER<br/>ACME ROOFING INC<br/>100 MAIN ST<br/>FORT LAUDERDALE, FL, 33301<br/>B - STATE - ROOF CCC1234567</td></tr></table>
<h1>Project Description:</h1><span>REROOF SHINGLE 25 SQ</span><h1>Owner:</h1><span>SOMEONE</span>`;

test("parses licensed professional, license number and project description", () => {
  const d = parseAccelaDetail(html);
  expect(d.recordStatus).toBe("Issued");
  expect(d.licenseNumber).toBe("CCC1234567");
  expect(d.licensedProfessional).toContain("ACME ROOFING INC");
  expect(d.projectDescription).toBe("REROOF SHINGLE 25 SQ");
});

test("a page without a licensed professional yields no license", () => {
  expect(
    parseAccelaDetail("<html>Record Status:</span> <span>Complete</span></html>").licenseNumber,
  ).toBeNull();
});
