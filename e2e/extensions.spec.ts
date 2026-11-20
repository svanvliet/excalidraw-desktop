import { test, expect, type Page } from "@playwright/test";

/**
 * Extensions bar smoke (docs/extensions.md): drop an image, mask it to a circle from the
 * selection bar, and confirm the change is a single undo step; then stack a border on the
 * mask and check the rendered pixels follow the circle (and the rectangle once unmasked).
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

type Px = "bg" | "red" | "blue" | "other";

/**
 * Samples Excalidraw's static canvas (the selection outline lives on the interactive one) at
 * points given as fractions of the drawn image's bounding box, found by scanning for
 * non-background pixels.
 */
async function sample(page: Page, points: Record<string, [number, number]>) {
  return page.evaluate((pts) => {
    const c = document.querySelector<HTMLCanvasElement>(".excalidraw__canvas.static")!;
    const { data, width, height } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    const at = (x: number, y: number) => data.slice((y * width + x) * 4, (y * width + x) * 4 + 4);
    const bg = at(0, 0);
    const near = (p: Uint8ClampedArray, q: ArrayLike<number>) =>
      Math.abs(p[0]! - q[0]!) + Math.abs(p[1]! - q[1]!) + Math.abs(p[2]! - q[2]!) < 60;
    let [x0, y0, x1, y1] = [width, height, -1, -1];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (!near(at(x, y), bg)) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
    const out: Record<string, string> = {};
    for (const [k, [fx, fy]] of Object.entries(pts)) {
      const p = at(Math.round(x0 + fx * (x1 - x0)), Math.round(y0 + fy * (y1 - y0)));
      out[k] = near(p, bg)
        ? "bg"
        : near(p, [0xe0, 0x31, 0x31])
          ? "red"
          : near(p, [0x19, 0x71, 0xc2])
            ? "blue"
            : "other";
    }
    return { box: [x1 - x0, y1 - y0], px: out as Record<string, Px> };
  }, points);
}

test("stacks a border on the mask that traces the circle, then the rectangle", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await dropImage(page);
  const box = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const bar = page.getByRole("toolbar", { name: "Extensions" });
  await expect(bar).toBeVisible({ timeout: 10_000 });

  await bar.getByRole("button", { name: "Circle" }).click();
  await bar.getByRole("button", { name: "Thick" }).click();
  await bar.getByRole("button", { name: "Border blue" }).click();
  await expect(bar.getByRole("button", { name: "Border blue" })).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByRole("button", { name: "Circle" })).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByRole("button", { name: "Thick" })).toHaveAttribute("aria-pressed", "true");

  // Thick = 8 of the image's 64 units, so the ring spans 0–12.5% in from each edge.
  const points = {
    centre: [0.5, 0.5],
    leftEdge: [0.04, 0.5],
    topEdge: [0.5, 0.04],
    corner: [0.06, 0.06],
    insideRing: [0.2, 0.5],
  } satisfies Record<string, [number, number]>;
  await expect
    .poll(() => sample(page, points).then((r) => r.px))
    .toEqual({ centre: "red", leftEdge: "blue", topEdge: "blue", corner: "bg", insideRing: "red" });
  if (process.env.EXT_SMOKE_SHOT) await page.screenshot({ path: process.env.EXT_SMOKE_SHOT });

  await bar.getByRole("button", { name: "Remove mask" }).click();
  await expect(bar.getByRole("button", { name: "Remove mask" })).toBeHidden();
  await expect(bar.getByRole("button", { name: "Thick" })).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => sample(page, points).then((r) => r.px))
    .toEqual({ centre: "red", leftEdge: "blue", topEdge: "blue", corner: "blue", insideRing: "red" });

  // Every action above was one undo step: undo the removal, the colour, the width, the mask.
  for (let i = 0; i < 4; i++) await page.keyboard.press("ControlOrMeta+z");
  await expect(bar.getByRole("button", { name: "Remove border" })).toBeHidden();
  await expect(bar.getByRole("button", { name: "Remove mask" })).toBeHidden();
});
