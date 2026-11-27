import { expect, test } from "@playwright/test";

test("explorer with WebGL disabled shows the notice and lists aged roofs for a lat/lon center", async ({
  page,
}) => {
  await page.goto("/#/explorer");
  await expect(page.getByTestId("map-fallback")).toBeVisible();
  await page.getByLabel("Latitude").fill("26.122");
  await page.getByLabel("Longitude").fill("-80.137");
  await page.getByRole("button", { name: "Set center" }).click();
  await expect(page.getByTestId("aged-roofs").locator("tbody tr").first()).toBeVisible();
});
