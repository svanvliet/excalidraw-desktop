import { test, expect, type Page } from "@playwright/test";

/**
 * Image controls smoke (docs/extensions.md § "UI surface"): drop an image, and drive the Stroke /
 * Mask sections we inject into Excalidraw's own properties panel. Checks each change is one undo
 * step and that the rendered border follows the mask (circle, then rectangle), dashed or sloppy.
 * Also guards the panel DOM the injection depends on across Excalidraw upgrades.
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

/** Drops the image, selects it by clicking (which also focuses Excalidraw) and finds our panel. */
async function selectDroppedImage(page: Page) {
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await dropImage(page);
  // Pins the DOM contract the injection relies on (ImagePropertiesPanel's PANEL_SELECTOR).
  const panel = page.locator(".App-menu__left .panelColumn > [data-testid=image-props-native]");
  // Excalidraw selects the dropped image once inserted (async), but only records the insert in
  // history with the next commit; deselect and click it again like a user so undo can't take it.
  await expect(panel).toBeVisible({ timeout: 10_000 });
  const box = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  await page.mouse.click(box.x + box.width - 40, box.y + box.height - 120);
  await expect(panel).toHaveCount(0);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("image-props-dock")).toHaveCount(0);
  return panel;
}

const shot = (page: Page, name: string) =>
  process.env.EXT_SMOKE_SHOT
    ? page.screenshot({ path: process.env.EXT_SMOKE_SHOT.replace(/\.png$/, `-${name}.png`) })
    : undefined;

test("masks a selected image from the native panel as one undo step", async ({ page }) => {
  const panel = await selectDroppedImage(page);
  // Sits where Stroke does for shapes: right after the panel's first slot, above Edges.
  await expect(panel.getByText("Stroke", { exact: true })).toBeVisible();
  const circle = panel.getByRole("button", { name: "Circle" });
  await circle.click();
  await expect(circle).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("button", { name: "No mask" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.keyboard.press("ControlOrMeta+z");
  await expect(circle).toHaveAttribute("aria-pressed", "false");
  await expect(panel.getByRole("button", { name: "No mask" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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

/**
 * For each of `n` angles around the drawn circle's centre, whether any blue pixel lies on the
 * outer `band` of its radius: all true for a solid ring, a mix for a dashed one.
 */
async function ringCoverage(page: Page, n = 90, band = 0.12) {
  return page.evaluate(
    ([n, band]) => {
      const c = document.querySelector<HTMLCanvasElement>(".excalidraw__canvas.static")!;
      const { data, width, height } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
      const at = (x: number, y: number) => data.slice((y * width + x) * 4, (y * width + x) * 4 + 4);
      const bg = at(0, 0);
      const dist = (p: Uint8ClampedArray, q: ArrayLike<number>) =>
        Math.abs(p[0]! - q[0]!) + Math.abs(p[1]! - q[1]!) + Math.abs(p[2]! - q[2]!);
      let [x0, y0, x1, y1] = [width, height, -1, -1];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          if (dist(at(x, y), bg) >= 60) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
          }
      const [cx, cy, r] = [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2];
      return Array.from({ length: n }, (_, i) => {
        const a = (i / n) * 2 * Math.PI;
        for (let f = 1 - band; f <= 1; f += 0.005) {
          const p = at(Math.round(cx + Math.cos(a) * r * f), Math.round(cy + Math.sin(a) * r * f));
          if (dist(p, [0x19, 0x71, 0xc2]) < 90) return true;
        }
        return false;
      });
    },
    [n, band] as const,
  );
}

test("stacks a border on the mask that traces the circle, then the rectangle", async ({ page }) => {
  const panel = await selectDroppedImage(page);
  const pressed = (name: string) =>
    expect(panel.getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

  await panel.getByRole("button", { name: "Circle" }).click();
  await pressed("Circle");
  // Stroke width etc. only appear once there is a border.
  await expect(panel.getByTestId("image-stroke-width")).toHaveCount(0);
  await panel.getByRole("button", { name: "Stroke #1971c2" }).click();
  await pressed("Stroke #1971c2");
  await panel.getByRole("button", { name: "Extra bold" }).click();
  await pressed("Extra bold");
  await pressed("Solid");
  await pressed("Architect");

  // Extra bold = 4 of the image's 64 units, so the ring spans 0–6.25% in from each edge.
  const points = {
    centre: [0.5, 0.5],
    leftEdge: [0.025, 0.5],
    topEdge: [0.5, 0.025],
    corner: [0.03, 0.03],
    insideRing: [0.2, 0.5],
  } satisfies Record<string, [number, number]>;
  await expect
    .poll(() => sample(page, points).then((r) => r.px), { timeout: 10_000 })
    .toEqual({ centre: "red", leftEdge: "blue", topEdge: "blue", corner: "bg", insideRing: "red" });
  await shot(page, "panel");

  await panel.getByRole("button", { name: "No mask" }).click();
  await pressed("No mask");
  await pressed("Extra bold");
  await expect
    .poll(() => sample(page, points).then((r) => r.px), { timeout: 10_000 })
    .toEqual({
      centre: "red",
      leftEdge: "blue",
      topEdge: "blue",
      corner: "blue",
      insideRing: "red",
    });

  // Every action above was one undo step: undo the unmask, the width, the colour, the mask.
  for (let i = 0; i < 4; i++) await page.keyboard.press("ControlOrMeta+z");
  await expect(panel.getByTestId("image-stroke-width")).toHaveCount(0);
  await pressed("No mask");
});

test("draws dashed and sloppy borders along the circle mask", async ({ page }) => {
  const panel = await selectDroppedImage(page);
  await panel.getByRole("button", { name: "Circle" }).click();

  // Colour from the native-style popover: palette swatch, then its darkest shade.
  await panel.getByRole("button", { name: "Show stroke colour picker" }).click();
  const popover = page.getByTestId("image-stroke-popover");
  await popover.getByRole("button", { name: "blue", exact: true }).click();
  await popover.getByRole("button", { name: "Shade 5" }).click();
  await expect(popover.getByRole("textbox", { name: "Stroke hex code" })).toHaveValue("1971c2");
  await shot(page, "picker");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  await panel.getByRole("button", { name: "Extra bold" }).click();
  await expect
    .poll(async () => (await ringCoverage(page)).every(Boolean), { timeout: 10_000 })
    .toBe(true);

  await panel.getByRole("button", { name: "Dashed" }).click();
  await expect(panel.getByRole("button", { name: "Dashed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Dashes: blue all the way round, but with gaps.
  await expect
    .poll(
      async () => {
        const ring = await ringCoverage(page);
        const blue = ring.filter(Boolean).length / ring.length;
        return blue > 0.3 && blue < 0.9;
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  await panel.getByRole("button", { name: "Solid" }).click();
  await panel.getByRole("button", { name: "Cartoonist" }).click();
  await expect(panel.getByRole("button", { name: "Cartoonist" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Sloppy but still a closed ring that follows the circle.
  await expect
    .poll(async () => (await ringCoverage(page, 90, 0.2)).filter(Boolean).length, {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(86);
  await shot(page, "sloppy");
});

test("uses the docked island on the mobile layout until the properties sheet opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await dropImage(page);
  const dock = page.getByTestId("image-props-dock");
  await expect(dock).toBeVisible({ timeout: 10_000 });
  await expect(dock.getByRole("button", { name: "Circle" })).toBeVisible();
  await shot(page, "mobile-dock");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const sheet = page.locator(".App-mobile-menu .panelColumn > [data-testid=image-props-native]");
  await expect(sheet).toBeVisible();
  await expect(dock).toHaveCount(0);
  await shot(page, "mobile-sheet");
});
