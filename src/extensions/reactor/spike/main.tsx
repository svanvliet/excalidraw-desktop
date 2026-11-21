/**
 * EXPERIMENTAL reactor spike harness (docs/reactor-spike.md), driven by
 * e2e/spikes/reactor.spike.ts. Dev-server only; not part of the app or its build.
 *
 * URL params:
 * - `mode=reactor|baseline` — with or without the reactor (baseline = same scene, no derivation).
 * - `apply=replace|mutate` — the reactor's apply strategy (see ReactorOptions.apply).
 * - `instances=N` — instances of a 10-element master (5 labelled rects). Default 99 → 1,000 elements.
 * - `filler=N` — extra plain rectangles (to reach ~1,000 elements with few targets).
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { convertToExcalidrawElements, Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { createReactor, type El, type Reactor } from "../reactor";
import { mirrorRule, withMirrorLink, type MirrorLink } from "../mirrorRule";
import { mirrorOnDuplicate } from "../duplicate";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "reactor";
const instances = Number(params.get("instances") ?? 99);
const filler = Number(params.get("filler") ?? 0);
const apply = params.get("apply") === "mutate" ? "mutate" : "replace";

const CHILDREN = 5;
const COLS = 10;
const W = 600;
const H = 150;
/** Instance 1, child 0: override equal to the source label (native-wrap cross-check). */
const SAME_OVERRIDE = { instance: 1, child: 0 };
/** Instance 2, child 0: a long override (re-measure). */
const LONG_OVERRIDE = "an overridden label that is much longer than the master";

function component(ox: number, oy: number, group: string): El[] {
  const skel: ExcalidrawElementSkeleton[] = [];
  for (let c = 0; c < CHILDREN; c++)
    skel.push({
      type: "rectangle",
      x: ox + c * 110,
      y: oy,
      width: 90,
      height: 60,
      groupIds: [group],
      label: { text: `Item ${c}`, fontSize: 16 },
    } as ExcalidrawElementSkeleton);
  return convertToExcalidrawElements(skel);
}

function buildScene(): El[] {
  const master = component(0, 0, "master");
  const out: El[] = [];
  const masterRects = master.filter((e) => e.type === "rectangle");
  const masterTexts = masterRects.map(
    (r) => master.find((e) => (e as ExcalidrawTextElement).containerId === r.id)!,
  );
  master.forEach((e) => {
    const c = e.type === "rectangle" ? masterRects.indexOf(e) : masterTexts.indexOf(e);
    out.push(withMirrorLink(e, { role: "source", key: `${e.type}${c}` }));
  });
  for (let i = 1; i <= instances; i++) {
    const dx = (i % COLS) * W;
    const dy = Math.floor(i / COLS) * H;
    const inst = component(dx, dy, `inst${i}`);
    const rects = inst.filter((e) => e.type === "rectangle");
    for (const e of inst) {
      const isText = e.type === "text";
      const c = isText
        ? rects.findIndex((r) => r.id === (e as ExcalidrawTextElement).containerId)
        : rects.findIndex((r) => r.id === e.id);
      const link: Extract<MirrorLink, { role: "target" }> = {
        role: "target",
        key: `${e.type}${c}`,
        dx,
        dy,
      };
      if (isText && c === 0 && i === SAME_OVERRIDE.instance) link.overrides = { text: "Item 0" };
      if (isText && c === 0 && i === 2) link.overrides = { text: LONG_OVERRIDE };
      out.push(withMirrorLink(e, link));
    }
  }
  if (filler > 0) {
    const skel: ExcalidrawElementSkeleton[] = [];
    for (let f = 0; f < filler; f++)
      skel.push({
        type: "rectangle",
        x: (f % 40) * 60,
        y: 400 + Math.floor(f / 40) * 60,
        width: 40,
        height: 40,
      } as ExcalidrawElementSkeleton);
    out.push(...convertToExcalidrawElements(skel));
  }
  return out;
}

interface SpikeGlobals {
  api?: ExcalidrawImperativeAPI;
  reactor?: Reactor;
  flushMs: number[];
  frames: number[];
  recording: boolean;
  ready: boolean;
}
const spike: SpikeGlobals = { flushMs: [], frames: [], recording: false, ready: false };
(window as unknown as { __spike: SpikeGlobals }).__spike = spike;

function frameLoop(t: number) {
  if (spike.recording) spike.frames.push(t);
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

// eslint-disable-next-line react-refresh/only-export-components -- entry module, never hot-reloaded as a component
function Spike() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [elements] = useState(buildScene);
  useEffect(() => {
    if (!api) return;
    spike.api = api;
    if (mode === "reactor") {
      const reactor = createReactor({
        api,
        rules: [mirrorRule],
        apply,
        schedule: (cb) => {
          const id = requestAnimationFrame(() => {
            cb();
            if (spike.recording) spike.flushMs.push(reactor.stats.lastFlushMs);
          });
          return () => cancelAnimationFrame(id);
        },
      });
      spike.reactor = reactor;
      spike.ready = true;
      return () => reactor.dispose();
    }
    spike.ready = true;
  }, [api]);
  return (
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={{ elements, scrollToContent: true }}
      onDuplicate={mode === "reactor" ? mirrorOnDuplicate : undefined}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Spike />
  </StrictMode>,
);
