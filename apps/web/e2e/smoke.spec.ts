import { expect, test } from "@playwright/test";

test("the page loads", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator("main")).toBeAttached();
});
