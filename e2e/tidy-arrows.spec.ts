import { test, expect, type Page } from "@playwright/test";

/**
 * Tidy Arrows smoke (docs/requirements.md FR-60): an org chart whose CEO → Ops arrow runs
 * straight through a Note card. Layout ▸ Tidy Arrows (Convert Straight Arrows) from the toolbar's
 * Layout dropdown must re-route every arrow as an elbow that crosses no card other than its own
 * two ends, without moving any shape, and a single undo must restore the scene.
 */

type El = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: [number, number][];
  elbowed?: boolean;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  isDeleted?: boolean;
  customData?: { name?: string };
};

const base = {
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  updated: 1,
  link: null,
  locked: false,
};

const W = 120;
const H = 60;
const pos: Record<string, [number, number]> = {
  ceo: [300, 0],
  note: [300, 150], // squarely between CEO and Ops
  eng: [0, 300],
  ops: [300, 300],
  fin: [600, 300],
};
const edges = [
  ["a1", "ceo", "eng"],
  ["a2", "ceo", "ops"],
  ["a3", "ceo", "fin"],
] as const;

function orgChart() {
  const box = (id: string) => ({
    ...base,
    id,
    customData: { name: id },
    type: "rectangle",
    x: pos[id]![0],
    y: pos[id]![1],
    width: W,
    height: H,
    boundElements: edges
      .filter((e) => e[1] === id || e[2] === id)
      .map(([a]) => ({ id: a, type: "arrow" })),
  });
  const arrow = ([id, from, to]: (typeof edges)[number]) => {
    const [fx, fy] = pos[from]!;
    const [tx, ty] = pos[to]!;
    return {
      ...base,
      id,
      customData: { name: id },
      type: "arrow",
      x: fx + W / 2,
      y: fy + H,
      width: Math.abs(tx - fx),
      height: Math.abs(ty - fy - H),
      points: [
        [0, 0],
        [tx - fx, ty - fy - H],
      ],
      boundElements: [],
      startBinding: { elementId: from, focus: 0, gap: 4 },
      endBinding: { elementId: to, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    };
  };
  return [...Object.keys(pos).map(box), ...edges.map(arrow)];
}

async function setup(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string };
    w.__copied = "";
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void (w.__copied = t) },
    });
  });
}

async function paste(page: Page, elements: unknown[]) {
  await page.evaluate((els) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", JSON.stringify({ type: "excalidraw/clipboard", elements: els }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, elements);
}

async function readScene(page: Page): Promise<Record<string, El>> {
  await page.keyboard.press("ControlOrMeta+a");
  await page.evaluate(() => ((window as unknown as { __copied: string }).__copied = ""));
  await page.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied: string }).__copied))
    .not.toBe("");
  const text = await page.evaluate(() => (window as unknown as { __copied: string }).__copied);
  const els = (JSON.parse(text) as { elements: El[] }).elements.filter((e) => !e.isDeleted);
  const name = new Map(els.map((e) => [e.id, e.customData?.name ?? e.id]));
  const named = (b: { elementId: string } | null | undefined) =>
    b ? { elementId: name.get(b.elementId) ?? b.elementId } : b;
  return Object.fromEntries(
    els.map((e) => [
      name.get(e.id)!,
      { ...e, startBinding: named(e.startBinding), endBinding: named(e.endBinding) },
    ]),
  );
}

/** Hands keyboard focus back to the editor without a click (a click would change the selection). */
async function refocusEditor(page: Page) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.querySelector<HTMLElement>(".excalidraw")?.focus();
  });
}

async function focusCanvas(page: Page) {
  const box = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 100);
}

/** Does segment p→q pass through the interior of the card (1px inset, so touching edges is fine)? */
function crosses(p: [number, number], q: [number, number], c: El): boolean {
  const [minX, minY, maxX, maxY] = [c.x + 1, c.y + 1, c.x + c.width - 1, c.y + c.height - 1];
  if (p[0] === q[0]) {
    return p[0] > minX && p[0] < maxX && Math.max(p[1], q[1]) > minY && Math.min(p[1], q[1]) < maxY;
  }
  if (p[1] === q[1]) {
    return p[1] > minY && p[1] < maxY && Math.max(p[0], q[0]) > minX && Math.min(p[0], q[0]) < maxX;
  }
  // Diagonal: sample it.
  for (let t = 0; t <= 1; t += 0.01) {
    const x = p[0] + (q[0] - p[0]) * t;
    const y = p[1] + (q[1] - p[1]) * t;
    if (x > minX && x < maxX && y > minY && y < maxY) return true;
  }
  return false;
}

function crossings(scene: Record<string, El>): string[] {
  const out: string[] = [];
  for (const [id, from, to] of edges) {
    const a = scene[id]!;
    const pts = a.points!.map(([x, y]) => [a.x + x, a.y + y] as [number, number]);
    for (const card of Object.keys(pos)) {
      if (card === from || card === to) continue;
      for (let i = 1; i < pts.length; i++) {
        if (crosses(pts[i - 1]!, pts[i]!, scene[card]!)) out.push(`${id} × ${card}`);
      }
    }
  }
  return out;
}

const shapes = (s: Record<string, El>) =>
  Object.fromEntries(
    Object.keys(pos).map((id) => [id, [s[id]!.x - s.ceo!.x, s[id]!.y - s.ceo!.y]]),
  );

test("toolbar Layout ▸ Tidy Arrows routes arrows around cards, as one undo step", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await focusCanvas(page);
  await paste(page, orgChart());
  await focusCanvas(page);
  const before = await readScene(page);
  expect(crossings(before)).toContain("a2 × note");

  await page.getByTestId("toolbar-layout").click();
  const menu = page.getByTestId("layout-menu-list");
  await expect(menu.getByRole("menuitem", { name: "Tidy Arrows", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Make Stack/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Convert Straight Arrows/ }).click();
  await expect(menu).toBeHidden();
  await refocusEditor(page);

  let after: Record<string, El> = {};
  await expect
    .poll(async () => {
      after = await readScene(page);
      return edges.every(([id]) => after[id]!.elbowed);
    })
    .toBe(true);
  expect(crossings(after)).toEqual([]);
  expect(shapes(after)).toEqual(shapes(before));
  for (const [id, from, to] of edges) {
    expect(after[id]!.startBinding?.elementId).toBe(from);
    expect(after[id]!.endBinding?.elementId).toBe(to);
    const pts = after[id]!.points!;
    for (let i = 1; i < pts.length; i++) {
      const [p, q] = [pts[i - 1]!, pts[i]!];
      expect(Math.abs(p[0] - q[0]) < 0.5 || Math.abs(p[1] - q[1]) < 0.5, `${id} orthogonal`).toBe(
        true,
      );
    }
  }

  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => {
      const s = await readScene(page);
      return edges.map(([id]) => s[id]!.elbowed ?? false);
    })
    .toEqual([false, false, false]);
  const undone = await readScene(page);
  expect(crossings(undone)).toContain("a2 × note");
  expect(shapes(undone)).toEqual(shapes(before));
});
