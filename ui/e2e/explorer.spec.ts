import { expect, test } from "@playwright/test";

test("serve --fixture shows the UNPUBLISHED banner; Runs lists groups with CIDs", async ({ page }) => {
  await page.goto("/#/runs");
  await expect(page.getByTestId("unpublished-banner")).toContainText("UNPUBLISHED");
  await expect(page.getByRole("heading", { name: /Run fixture/ })).toBeVisible();
  await expect(page.getByText("property_improvement").first()).toBeVisible();
});

test("Quality page renders every qa.json check with its status", async ({ page, request }) => {
  const qa = await (await request.get("/api/qa/current")).json();
  await page.goto("/#/quality");
  await expect(page.getByTestId("qa-summary")).toContainText(`${qa.counts.pass} pass`);
  for (const c of qa.checks)
    await expect(page.locator("code", { hasText: new RegExp(`^${c.id}$`) })).toBeVisible();
  await expect(page.locator(".badge-fail").first()).toBeVisible();
});

test("manifest page renders gateway links built from CIDs; Verify now is disabled while unpublished", async ({
  page,
}) => {
  await page.goto("/#/manifest");
  await expect(page.getByTestId("verify-now")).toBeDisabled();
  const link = page.locator('a[href^="https://ipfs.io/ipfs/baguqeera"]').first();
  await expect(link).toBeVisible();
  const cid = (await link.getAttribute("href"))!.split("/ipfs/")[1];
  await expect(page.locator(`a[href="https://dweb.link/ipfs/${cid}"]`).first()).toBeVisible();
});

test("explorer: city picker + 5 miles lists aged roofs and long-open permits; clicking the map moves the pin", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#/explorer");
  await page.getByTestId("city-picker").selectOption("FORT LAUDERDALE");
  await expect(page).toHaveURL(/lat=26\.14123/);
  await expect(page.getByTestId("aged-roofs").locator("tbody tr").first()).toBeVisible();
  await expect(page.getByTestId("open-permits").locator("tbody tr").first()).toBeVisible();
  await expect(page.getByTestId("uncovered-note")).toHaveCount(0); // all fixture parcels here are in a covered city
  const map = page.getByTestId("map");
  await expect(map.locator("canvas")).toBeVisible();
  await page.waitForTimeout(800); // let the camera ease to the center
  await map.click({ position: { x: 40, y: 40 } });
  await expect(page).not.toHaveURL(/lat=26\.14123&/);
  // the map's GeoJSON worker must load (points and radius ring are drawn by it)
  expect(errors.filter((e) => /worker|maplibre/i.test(e))).toEqual([]);
});

test("explorer: a radius over a jurisdiction without permit data names it", async ({ page }) => {
  await page.goto("/#/explorer");
  await page.getByTestId("city-picker").selectOption("HOLLYWOOD");
  await expect(page.getByTestId("uncovered-note")).toContainText("Hollywood");
  await expect(page.getByTestId("uncovered-note")).toContainText("year built");
});

test("property page shows owner, permits, entities and provenance", async ({ page, request }) => {
  const r = await (
    await request.get("/api/query/aged-roofs?lat=26.122&lon=-80.137&radiusMiles=5&minRoofAgeYears=0&limit=1")
  ).json();
  const id = r.rows[0].parcel_identifier;
  await page.goto(`/#/property/${id}`);
  await expect(page.getByText("Owner & occupancy")).toBeVisible();
  await expect(page.getByText("Lexicon entities & provenance")).toBeVisible();
  await expect(page.getByRole("link", { name: /Broward Property Appraiser/ })).toHaveAttribute(
    "href",
    new RegExp(id),
  );
});

test("SQL console runs a SELECT and rejects DDL", async ({ page }) => {
  await page.goto("/#/sql");
  await page.getByRole("button", { name: /^Run/ }).click();
  await expect(page.getByTestId("sql-result").locator("tbody tr").first()).toBeVisible();
  await page.getByLabel("SQL").fill("drop table mv_property");
  await page.getByRole("button", { name: /^Run/ }).click();
  await expect(page.getByRole("alert")).toContainText("only SELECT");
});

test("MCP console lists 13 tools and a find_aged_roofs call returns rows", async ({ page }) => {
  await page.goto("/#/mcp");
  await page.getByTestId("mcp-list").click();
  await expect(page.getByTestId("mcp-tool-count")).toContainText("13 tools");
  await page.getByLabel("Tool", { exact: true }).selectOption("find_aged_roofs");
  await page.getByTestId("mcp-call").click();
  const exchange = page.locator("details.exchange").first();
  await expect(exchange).toContainText("tools/call");
  await expect(exchange).toContainText("parcel_identifier");
});

test("agent page shows answer, citations, assumptions, retrieved evidence and a show-on-map action", async ({
  page,
}) => {
  await page.goto("/#/agent");
  await page.getByRole("button", { name: "Ask" }).click();
  const answer = page.getByTestId("agent-answer").first();
  await expect(answer).toContainText("Found");
  await expect(answer).toContainText("Assumptions");
  await expect(answer).toContainText("Citations");
  await answer.getByTestId("agent-evidence").locator("summary").click();
  await expect(answer.getByTestId("agent-evidence")).toContainText("resolve_place");
  await expect(answer.getByTestId("agent-evidence")).toContainText("find_aged_roofs");
  // follow-up reuses the area
  await page.getByLabel("Question").fill("Which properties near that area have open roofing permits?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByTestId("agent-answer").nth(1)).toContainText("Reused the previous search area");
  await answer.getByRole("button", { name: /Show \d+ on map/ }).click();
  await expect(page).toHaveURL(/#\/explorer.*pins=agent/);
});

test("WASM proof page computes the aged-roofs query in the browser and matches the API", async ({ page }) => {
  await page.goto("/#/wasm");
  await page.getByTestId("wasm-run").click();
  await expect(page.getByTestId("wasm-result")).toContainText("Same rows as the API", { timeout: 45_000 });
});
