import { test, expect, type Page } from "@playwright/test";

/**
 * Extensions bar smoke (docs/extensions.md): drop an image, mask it to a circle from the
 * selection bar, and confirm the change is a single undo step.
 */

/** 64×64 opaque red PNG, built in the page so the fixture stays dependency-free. */
async function dropImage(page: Page) {
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#e03131";
    ctx.fillRect(0, 0, 64, 64);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "red.png", { type: "image/png" }));
    const target = document.querySelector(".excalidraw .excalidraw__canvas.interactive")!;
    const rect = target.getBoundingClientRect();
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...at }),
      );
    }
  });
}

test("masks a selected image to a circle as one undo step", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await dropImage(page);
  // Select it by clicking, like a user would (this also focuses Excalidraw's container).
  const box = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const bar = page.getByRole("toolbar", { name: "Extensions" });
  await expect(bar).toBeVisible({ timeout: 10_000 });
  const circle = bar.getByRole("button", { name: "Circle" });
  await circle.click();
  await expect(circle).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByRole("button", { name: "Remove mask" })).toBeVisible();
  if (process.env.EXT_SMOKE_SHOT) await page.screenshot({ path: process.env.EXT_SMOKE_SHOT });

  await page.keyboard.press("ControlOrMeta+z");
  await expect(circle).toHaveAttribute("aria-pressed", "false");
  await expect(bar.getByRole("button", { name: "Remove mask" })).toBeHidden();
});
