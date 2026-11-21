import { test, expect, type Page } from "@playwright/test";

/**
 * Line anchors smoke (docs/plan.md D-DX15, FR-61) against the real Excalidraw 0.18.1 editor:
 * dragging an arrow end onto a face midpoint (with the snap dots showing) snaps, binds and pins
 * it; the pin follows the shape and undoes with it; Cmd/Ctrl bypasses the snap; drawing a new
 * arrow between two face midpoints pins both ends.
 */

const PIN_KEY = "excalidrawDesktop.pin";

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("excalidraw-desktop:e2e", "1"));
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => window.__canvas && window.__e2e);
}

/** Boxes A (left) and B (right, solid so it can be grabbed), optionally an arrow A → B. */
async function seed(page: Page, withArrow = true) {
  await page.evaluate((withArrow) => {
    const els = window.__e2e!.convertToExcalidrawElements(
      [
        { type: "rectangle", id: "A", x: 500, y: 150, width: 120, height: 80 },
        {
          type: "rectangle",
          id: "B",
          x: 800,
          y: 350,
          width: 120,
          height: 80,
          backgroundColor: "#a5d8ff",
          fillStyle: "solid",
        },
        ...(withArrow
          ? [
              {
                type: "arrow",
                id: "a",
                x: 625,
                y: 190,
                width: 170,
                height: 200,
                start: { id: "A" },
                end: { id: "B" },
              },
            ]
          : []),
      ] as never,
      { regenerateIds: false },
    );
    window.__canvas!.updateScene({ elements: els, captureUpdate: "IMMEDIATELY" as never });
  }, withArrow);
}

/** Scene → page coordinates. */
const toPage = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => {
      const s = window.__canvas!.getAppState();
      const z = s.zoom.value;
      return { x: (x + s.scrollX) * z + s.offsetLeft, y: (y + s.scrollY) * z + s.offsetTop };
    },
    [x, y],
  );

interface ArrowState {
  points: [number, number][];
  startBinding: { elementId: string } | null;
  endBinding: { elementId: string } | null;
  pin: Record<string, { id: string; anchor: string }> | undefined;
}

const arrowState = (page: Page, id?: string) =>
  page.evaluate(
    ([id, key]) => {
      const a = window
        .__canvas!.getSceneElements()
        .find((e) => (id ? e.id === id : e.type === "arrow")) as unknown as
        | {
            x: number;
            y: number;
            points: [number, number][];
            startBinding: ArrowState["startBinding"];
            endBinding: ArrowState["endBinding"];
            customData?: Record<string, unknown>;
          }
        | undefined;
      if (!a) return null;
      return {
        points: a.points.map(([px, py]) => [a.x + px, a.y + py]),
        startBinding: a.startBinding,
        endBinding: a.endBinding,
        pin: a.customData?.[key],
      } as ArrowState;
    },
    [id, PIN_KEY] as const,
  );

const lastPoint = (a: ArrowState) => a.points[a.points.length - 1];

function expectNear(p: readonly number[], q: readonly number[], tol = 1.5) {
  expect(Math.abs(p[0] - q[0])).toBeLessThan(tol);
  expect(Math.abs(p[1] - q[1])).toBeLessThan(tol);
}

/** Select arrow "a" with a click on its shaft, so its end handles can be grabbed. */
async function selectArrow(page: Page) {
  const a = (await arrowState(page, "a"))!;
  const [p, q] = [a.points[0], lastPoint(a)];
  const mid = await toPage(page, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  await page.mouse.click(mid.x, mid.y);
  await expect
    .poll(() =>
      page.evaluate(() => window.__canvas!.getAppState().selectedLinearElement?.elementId),
    )
    .toBe("a");
}

/** Drag arrow "a"'s end handle to scene point `to`, checking the dots mid-drag. */
async function dragEnd(page: Page, to: [number, number], modifier?: "ControlOrMeta") {
  const from = await toPage(page, ...lastPoint((await arrowState(page, "a"))!));
  const target = await toPage(page, ...to);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(target.x, target.y, { steps: 12 });
  if (!modifier) {
    await expect(page.getByTestId("snap-dots")).toBeVisible();
    await expect(page.locator(".snap-dots__dot--active")).toHaveCount(1);
  } else {
    await expect(page.getByTestId("snap-dots")).toHaveCount(0);
  }
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

test("dragging an arrow end onto a face midpoint pins it there through moves and undo", async ({
  page,
}) => {
  await open(page);
  await seed(page);
  await selectArrow(page);
  // B's north midpoint is (860, 350); drop a few pixels off it.
  await dragEnd(page, [864, 346]);
  await expect(page.getByTestId("snap-dots")).toHaveCount(0);

  await expect.poll(async () => (await arrowState(page, "a"))?.pin?.end?.anchor).toBe("n");
  let a = (await arrowState(page, "a"))!;
  expect(a.endBinding?.elementId).toBe("B");
  expectNear(lastPoint(a), [860, 345]);

  // A real drag of B: the pinned end rides along on the north midpoint.
  await page.keyboard.press("Escape");
  const grab = await toPage(page, 860, 400);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 120, grab.y + 60, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const b = await page.evaluate(
        () => window.__canvas!.getSceneElements().find((e) => e.id === "B")!.x,
      );
      return b;
    })
    .toBeGreaterThan(850);
  const bx = await page.evaluate(() => {
    const b = window.__canvas!.getSceneElements().find((e) => e.id === "B")!;
    return [b.x + b.width / 2, b.y - 5];
  });
  await expect.poll(async () => lastPoint((await arrowState(page, "a"))!)[0]).toBeCloseTo(bx[0], 0);
  a = (await arrowState(page, "a"))!;
  expectNear(lastPoint(a), bx);

  // One undo reverts the move together with the arrow.
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() =>
      page.evaluate(() => window.__canvas!.getSceneElements().find((e) => e.id === "B")!.x),
    )
    .toBe(800);
  await expect.poll(async () => lastPoint((await arrowState(page, "a"))!)[0]).toBeCloseTo(860, 0);
});

test("Cmd/Ctrl-drag places the end freely and drops the pin", async ({ page }) => {
  await open(page);
  await seed(page);
  await selectArrow(page);
  await dragEnd(page, [864, 346]);
  await expect.poll(async () => (await arrowState(page, "a"))?.pin?.end?.anchor).toBe("n");

  await dragEnd(page, [830, 345], "ControlOrMeta");
  await expect.poll(async () => (await arrowState(page, "a"))?.pin?.end).toBeUndefined();
  expectNear(lastPoint((await arrowState(page, "a"))!), [830, 345], 3);
});

test("drawing an arrow between two face midpoints pins both ends", async ({ page }) => {
  await open(page);
  await seed(page, false);
  await page.evaluate(() => window.__canvas!.setActiveTool({ type: "arrow" }));
  // A's east midpoint is (620, 190); B's west midpoint is (800, 390).
  const from = await toPage(page, 623, 192);
  const to = await toPage(page, 797, 388);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(page.locator(".snap-dots__dot--active")).toHaveCount(1);
  await page.mouse.up();

  await expect.poll(async () => (await arrowState(page))?.pin?.end?.anchor).toBe("w");
  const a = (await arrowState(page))!;
  expect(a.pin?.start).toEqual({ id: "A", anchor: "e" });
  expect(a.startBinding?.elementId).toBe("A");
  expect(a.endBinding?.elementId).toBe("B");
  expectNear(a.points[0], [625, 190]);
  expectNear(lastPoint(a), [795, 390]);
});
