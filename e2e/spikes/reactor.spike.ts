/**
 * EXPERIMENTAL reactor spike, point 2 (docs/reactor-spike.md): a real mouse
 * drag of a master on ~1,000 elements, measuring frame intervals and reactor
 * flush cost against a no-reactor baseline, then one Ctrl/Cmd+Z.
 */
import { expect, test, type Page } from "@playwright/test";

interface El {
  id: string;
  type: string;
  x: number;
  y: number;
  customData?: Record<string, { role: string; key: string; dx?: number; dy?: number }>;
}
const KEY = "excalidrawDesktop.reactorSpike";
const PAGE = "/src/extensions/reactor/spike/index.html";
const STEPS = 90;

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2);
};

async function open(page: Page, query: string, count: number) {
  await page.goto(`${PAGE}?${query}`);
  await page.waitForFunction(
    (n) => {
      const s = (
        window as never as { __spike: { ready: boolean; api?: { getSceneElements(): unknown[] } } }
      ).__spike;
      return s?.ready && (s.api?.getSceneElements().length ?? 0) >= n;
    },
    count,
    { timeout: 60_000 },
  );
  // Deterministic viewport: master rect 0 is at scene (0,0) → screen (100,100).
  await page.evaluate(() => {
    const s = (window as never as { __spike: { api: { updateScene(d: unknown): void } } }).__spike;
    s.api.updateScene({ appState: { scrollX: 100, scrollY: 100, zoom: { value: 1 } } });
  });
  await page.waitForTimeout(500);
}

const scene = (page: Page) =>
  page.evaluate(
    () =>
      (window as never as { __spike: { api: { getSceneElements(): El[] } } }).__spike.api
        .getSceneElements()
        .map(({ id, type, x, y, customData }) => ({ id, type, x, y, customData })) as El[],
  );

const nextFrame = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

/** Press on master rect 0 (selects the whole master group) and drag it one step per frame. */
async function drag(page: Page) {
  await page.evaluate(() => {
    const s = (
      window as never as { __spike: { recording: boolean; frames: number[]; flushMs: number[] } }
    ).__spike;
    s.frames.length = 0;
    s.flushMs.length = 0;
    s.recording = true;
  });
  const t0 = Date.now();
  await page.mouse.move(110, 110);
  await page.mouse.down();
  for (let i = 1; i <= STEPS; i++) {
    await page.mouse.move(110 + i * 2, 110 + i);
    await nextFrame(page);
  }
  await page.mouse.up();
  await nextFrame(page);
  await nextFrame(page);
  const wallMs = Date.now() - t0;
  const { frames, flushMs } = await page.evaluate(() => {
    const s = (
      window as never as { __spike: { recording: boolean; frames: number[]; flushMs: number[] } }
    ).__spike;
    s.recording = false;
    return { frames: [...s.frames], flushMs: [...s.flushMs] };
  });
  const intervals = frames.slice(1).map((t, i) => t - frames[i]);
  return {
    wallMs,
    frames: frames.length,
    frameP50: pct(intervals, 50),
    frameP95: pct(intervals, 95),
    frameMax: pct(intervals, 100),
    flushes: flushMs.length,
    flushP50: pct(flushMs, 50),
    flushP95: pct(flushMs, 95),
    flushMax: pct(flushMs, 100),
  };
}

const linkOf = (e: El) => e.customData?.[KEY];
const results: Record<string, unknown> = {};

test.afterAll(() => {
  console.log(`REACTOR_SPIKE_RESULTS ${JSON.stringify(results)}`);
});

for (const [name, query, count] of [
  ["many-targets", "instances=99", 1000],
  ["few-targets", "instances=9&filler=900", 1000],
] as const) {
  test(`baseline drag, ${name}`, async ({ page }) => {
    await open(page, `mode=baseline&${query}`, count);
    results[`baseline/${name}`] = await drag(page);
  });

  for (const apply of ["replace", "mutate"] as const)
    test(`reactor (${apply}) drag + undo, ${name}`, async ({ page }) => {
      await open(page, `mode=reactor&apply=${apply}&${query}`, count);
      const before = await scene(page);
      const src0 = before.find(
        (e) => linkOf(e)?.role === "source" && linkOf(e)?.key === "rectangle0",
      )!;
      const targets = before.filter(
        (e) => linkOf(e)?.role === "target" && linkOf(e)?.key === "rectangle0",
      );
      expect(targets.length).toBeGreaterThan(0);

      const perf = await drag(page);
      const stats = await page.evaluate(
        () =>
          (window as never as { __spike: { reactor: { stats: unknown } } }).__spike.reactor.stats,
      );
      results[`reactor-${apply}/${name}`] = { ...perf, targets: targets.length, stats };
      // In-place apply keeps the drag smooth: p95 frame within 30 fps even with 990 targets.
      // (`replace` regenerates every target's rough.js shape per frame: ~100 ms p95 here.)
      if (apply === "mutate") expect(perf.frameP95).toBeLessThan(33.4);

      // Live derivation reached every target, and the source actually moved.
      const after = await scene(page);
      const s1 = after.find((e) => e.id === src0.id)!;
      expect(s1.x).toBeGreaterThan(src0.x + 100);
      for (const t of targets) {
        const t1 = after.find((e) => e.id === t.id)!;
        expect(t1.x).toBe(s1.x + linkOf(t)!.dx!);
        expect(t1.y).toBe(s1.y + linkOf(t)!.dy!);
      }

      // One undo restores the source AND (via re-derivation) every target.
      await page.keyboard.press("ControlOrMeta+z");
      await nextFrame(page);
      await nextFrame(page);
      const undone = await scene(page);
      expect(undone.find((e) => e.id === src0.id)!.x).toBe(src0.x);
      for (const t of targets) {
        const t0 = before.find((e) => e.id === t.id)!;
        const t2 = undone.find((e) => e.id === t.id)!;
        expect([t2.x, t2.y]).toEqual([t0.x, t0.y]);
      }

      // ...and redo brings the drag back in one step.
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await nextFrame(page);
      await nextFrame(page);
      const redone = await scene(page);
      expect(redone.find((e) => e.id === src0.id)!.x).toBe(s1.x);
      const tr = targets[targets.length - 1];
      expect(redone.find((e) => e.id === tr.id)!.x).toBe(s1.x + linkOf(tr)!.dx!);
    });
}
