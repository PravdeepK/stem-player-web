import { expect, test } from "@playwright/test";

// A phone with WebGL blocked: the 3D player can't start, so its play,
// skip and volume controls have to be on screen and tappable.
test.use({ hasTouch: true, viewport: { width: 360, height: 740 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type === "webgl" || type === "webgl2") return null;
      return getContext.call(this, type, ...rest);
    } as typeof getContext;
  });
});

test("the player's controls show without WebGL", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".stage-caption")).toHaveText("Couldn’t load the 3D player. Stem controls are in the menu.");

  const controls = page.locator(".kbd-controls");
  await expect(controls.getByRole("button", { name: "Play" })).toBeDisabled();
  await expect(controls.getByRole("button", { name: "Back 10 seconds" })).toBeDisabled();

  // The menu opens over the stage when the player fails.
  await page.getByRole("button", { name: "Close menu" }).tap();
  await controls.getByRole("button", { name: "Volume down" }).tap();
  await expect(page.getByText("Volume 90%")).toBeVisible();
});
