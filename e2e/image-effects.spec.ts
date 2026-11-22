import { test, expect, type Page } from "@playwright/test";
import { openStripRow } from "./fixtures/strip";

/**
 * Image effects smoke (docs/extensions.md § "Grayscale", "Tint", "Shadow"): drives the effect
 * sections of the image panel and checks the rendered raster on Excalidraw's static canvas. Each
 * change must be one undo step, and the shadow must draw outside the image without moving it.
 * Runs in light and dark mode: dark mode inverts images on draw, so checks are relative (neutral
 * vs saturated, inside vs outside the image box) rather than exact colours.
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

/** Drops the image and selects it by clicking (so the insert is in history before our edits). */
async function selectDroppedImage(page: Page) {
  // Let the dropped image decode and draw before clicking around it. Under parallel load the
  // upstream insert occasionally leaves the new image undrawn (selected but invisible, before any
  // effect runs), so start over on a fresh page rather than fail the effect check.
  await expect(async () => {
    await page.goto("/");
    await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
    await dropImage(page);
    await stable(page, undefined, 5_000);
  }).toPass({ timeout: 30_000 });
  const panel = page.locator(".App-menu__left .panelColumn > [data-testid=image-props-native]");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  const box = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  await page.mouse.click(box.x + box.width - 40, box.y + box.height - 120);
  await expect(panel).toHaveCount(0);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(panel).toBeVisible();
  await openStripRow(page, "image-props");
  return panel;
}

interface Probe {
  /** Bounding box of saturated (image) pixels: [x0, y0, x1, y1]. */
  image: number[];
  /** Bounding box of every non-background pixel, shadow included. */
  all: number[];
  /** Mean colour at the centre of the image box. */
  centre: number[];
}

/**
 * Reads the static canvas (the selection outline lives on the interactive one). "Saturated"
 * survives Excalidraw's dark-mode invert + hue-rotate, and a grey shadow never is.
 */
async function probe(page: Page, minDiff = 24): Promise<Probe> {
  return page.evaluate((minDiff) => {
    const c = document.querySelector<HTMLCanvasElement>(".excalidraw__canvas.static")!;
    const { data, width, height } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    const at = (x: number, y: number) => data.slice((y * width + x) * 4, (y * width + x) * 4 + 3);
    const bg = at(0, 0);
    const box = () => [width, height, -1, -1];
    const grow = (b: number[], x: number, y: number) => {
      b[0] = Math.min(b[0]!, x);
      b[1] = Math.min(b[1]!, y);
      b[2] = Math.max(b[2]!, x);
      b[3] = Math.max(b[3]!, y);
    };
    const [image, all] = [box(), box()];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = at(x, y);
        const diff = Math.abs(p[0]! - bg[0]!) + Math.abs(p[1]! - bg[1]!) + Math.abs(p[2]! - bg[2]!);
        if (diff >= minDiff) grow(all, x, y);
        if (Math.max(...p) - Math.min(...p) >= 80) grow(image, x, y);
      }
    const [cx, cy] = [
      Math.round((image[0]! + image[2]!) / 2),
      Math.round((image[1]! + image[3]!) / 2),
    ];
    const centre = [0, 0, 0];
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const p = at(cx + dx, cy + dy);
        for (let i = 0; i < 3; i++) centre[i]! += p[i]! / 25;
      }
    return { image, all, centre: centre.map(Math.round) };
  }, minDiff);
}

/** Spread between the strongest and weakest channel: 0 for neutral grey. */
const chroma = (rgb: number[]) => Math.max(...rgb) - Math.min(...rgb);

/**
 * Probes a settled frame: something drawn and unchanged over 150ms. Skips the empty canvas before
 * the dropped image decodes and Excalidraw's grey loading placeholder, shown for a frame or two
 * whenever a stage swaps the element's file id.
 */
async function stable(page: Page, minDiff?: number, timeout = 15_000): Promise<Probe> {
  let last: Probe | undefined;
  await expect
    .poll(
      async () => {
        const a = await probe(page, minDiff);
        await page.waitForTimeout(150);
        const b = await probe(page, minDiff);
        last = b;
        return b.all[2]! >= 0 && JSON.stringify(a) === JSON.stringify(b);
      },
      { timeout },
    )
    .toBe(true);
  return last!;
}

/** Moves a native range to its max via the keyboard (commits on keyup, like a release). */
async function sliderToMax(page: Page, testId: string) {
  const slider = page.getByTestId(testId);
  await expect(slider).not.toHaveAttribute("aria-disabled");
  await slider.focus();
  await page.keyboard.press("End");
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`image effects (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test("grayscale neutralises the image as one undo step", async ({ page }) => {
      await selectDroppedImage(page);
      await expect(page.getByTestId("image-grayscale")).toHaveValue("0");
      const before = await stable(page);
      expect(chroma(before.centre)).toBeGreaterThan(80);

      await sliderToMax(page, "image-grayscale");
      await expect(page.getByTestId("image-grayscale")).toHaveValue("100");
      await expect.poll(async () => chroma((await stable(page)).centre)).toBeLessThan(8);

      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.getByTestId("image-grayscale")).toHaveValue("0");
      await expect.poll(async () => (await stable(page)).centre).toEqual(before.centre);
    });

    test("tint recolours the image and exposes its strength", async ({ page }) => {
      await selectDroppedImage(page);
      const before = await stable(page);
      await expect(page.getByTestId("image-tint-strength")).toHaveCount(0);

      await page.getByTestId("image-tint-top-pick-#1971c2").click();
      await expect(page.getByTestId("image-tint-strength")).toHaveValue("50");
      // Half-strength blue over red's luma: a clear move away from the original colour (the
      // distance survives the dark-mode invert, which is an isometry up to its 93% scale).
      const moved = (rgb: number[]) =>
        rgb.reduce((d, v, i) => d + Math.abs(v - before.centre[i]!), 0);
      await expect.poll(async () => moved((await stable(page)).centre)).toBeGreaterThan(90);

      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.getByTestId("image-tint-strength")).toHaveCount(0);
      await expect.poll(async () => (await stable(page)).centre).toEqual(before.centre);
    });

    test("shadow draws outside the image without moving it", async ({ page }) => {
      await selectDroppedImage(page);
      // Excalidraw pre-inverts images so dark mode shows their true colours: a #1e1e1e shadow on
      // the dark canvas is faint by design, so look for subtler differences from the background.
      const probeAll = (p: Page) => stable(p, scheme === "dark" ? 6 : 24);
      const before = await probeAll(page);
      expect(before.all).toEqual(before.image);

      await page.getByTestId("image-shadow-top-pick-#1e1e1e").click();
      await expect(page.getByTestId("image-shadow-opacity")).toBeVisible();
      let after!: Probe;
      // Wait past the grey loading placeholder Excalidraw draws at the new bounds (no image yet).
      await expect
        .poll(async () => {
          after = await probeAll(page);
          return after.image[2]! >= 0 && JSON.stringify(after.all) !== JSON.stringify(before.all);
        })
        .toBe(true);
      // The visible image stays put (±1px for resampling at the padded bitmap's edge)…
      after.image.forEach((v, i) => expect(Math.abs(v - before.image[i]!)).toBeLessThanOrEqual(1));
      // …and the default shadow (offset +6,+6) reaches further right/down than left/up.
      const [left, top] = [before.image[0]! - after.all[0]!, before.image[1]! - after.all[1]!];
      const [right, bottom] = [after.all[2]! - before.image[2]!, after.all[3]! - before.image[3]!];
      expect(right).toBeGreaterThan(left + 4);
      expect(bottom).toBeGreaterThan(top + 4);
      // Opacity at max darkens the shadow but keeps it outside the same image box.
      await sliderToMax(page, "image-shadow-opacity");
      await expect(page.getByTestId("image-shadow-opacity")).toHaveValue("100");

      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.getByTestId("image-shadow-opacity")).toHaveValue("35");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.getByTestId("image-shadow-opacity")).toHaveCount(0);
      await expect.poll(async () => (await probeAll(page)).all).toEqual(before.all);
    });
  });
}
