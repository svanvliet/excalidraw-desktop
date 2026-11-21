import "../../agent/scene/testHarness";
// Reactor core behaviour against a minimal fake scene API (no Excalidraw render): reconcile
// chaining between key-level rules, declared order, `invalidate`, and the chained loop guard.
import { describe, expect, it } from "vitest";
import { newElementWith } from "@excalidraw/excalidraw";
import { createReactor, type El, type ReactorApi, type ReactorRule } from "./reactor";

function fakeApi(initial: Array<Partial<El> & { id: string }>) {
  let elements = initial.map(
    (e, i) =>
      ({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        version: 1,
        versionNonce: i + 1,
        isDeleted: false,
        groupIds: [],
        boundElements: null,
        ...e,
      }) as unknown as El,
  );
  const listeners = new Set<(els: readonly El[]) => void>();
  const api: ReactorApi = {
    getSceneElementsIncludingDeleted: (() => elements) as never,
    onChange: ((cb: (els: readonly El[]) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }) as never,
    updateScene: ((data: { elements?: readonly El[] }) => {
      if (data.elements) elements = [...data.elements];
      for (const l of listeners) l(elements);
    }) as never,
  };
  return {
    api,
    get: (id: string) => elements.find((e) => e.id === id)!,
    edit(id: string, patch: Partial<El>) {
      elements = elements.map((e) => (e.id === id ? newElementWith(e, patch as never) : e));
      for (const l of listeners) l(elements);
    },
  };
}

/** `from` is the source of `key`; `to` is a target whose x follows the source's x (+ dx). */
function copyX(
  name: string,
  from: string,
  to: string,
  dx = 0,
  calls?: string[][],
  seesLaterWrites = false,
): ReactorRule {
  const key = `${name}:${from}`;
  return {
    name,
    seesLaterWrites,
    links: (el) =>
      el.id === from ? [{ role: "source", key }] : el.id === to ? [{ role: "target", key }] : [],
    reconcile: (_k, change, ctx) => {
      calls?.push([name, ...change.targets]);
      ctx.patch(to, { x: ctx.get(from)!.x + dx });
    },
  };
}

const manual = () => {
  const q: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      q.push(cb);
      return () => q.splice(q.indexOf(cb), 1);
    },
    frame: () => q.splice(0).forEach((cb) => cb()),
    pending: () => q.length,
  };
};

describe("reactor reconcile chaining", () => {
  it.each([
    ["declared order", false],
    ["reverse order, earlier rule opts into later writes", true],
  ])("propagates a → b → c across two key-level rules in one flush (%s)", (_n, reverse) => {
    const f = fakeApi([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const rules = [copyX("A", "a", "b", 5), copyX("B", "b", "c", 7, undefined, reverse)];
    const clock = manual();
    const r = createReactor({
      api: f.api,
      rules: reverse ? rules.reverse() : rules,
      schedule: clock.schedule,
    });
    f.edit("a", { x: 100 });
    clock.frame();
    expect(f.get("b").x).toBe(105);
    expect(f.get("c").x).toBe(112);
    expect(r.stats.flushes).toBe(1);
    expect(clock.pending()).toBe(0); // its own writes don't re-trigger
    r.dispose();
  });

  it("an earlier rule doesn't see later writes unless it opts in", () => {
    const f = fakeApi([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const clock = manual();
    const r = createReactor({
      api: f.api,
      rules: [copyX("B", "b", "c", 7), copyX("A", "a", "b", 5)],
      schedule: clock.schedule,
    });
    f.edit("a", { x: 100 });
    clock.frame();
    expect(f.get("b").x).toBe(105);
    expect(f.get("c").x).toBe(0);
    r.dispose();
  });

  it("stops a reconcile ping-pong at maxPasses", () => {
    const f = fakeApi([{ id: "a" }, { id: "b" }]);
    // A: b.x = a.x + 1 (a source, b target) · B: a.x = b.x + 1 (b source, a target)
    const r = createReactor({
      api: f.api,
      rules: [copyX("A", "a", "b", 1, undefined, true), copyX("B", "b", "a", 1)],
      schedule: manual().schedule,
      maxPasses: 3,
    });
    f.edit("a", { x: 10 });
    r.flush();
    expect(r.stats.loopGuardHits).toBe(1);
    r.dispose();
  });

  it("invalidate() re-runs rules for unchanged elements and reports them as targets", () => {
    const f = fakeApi([{ id: "a", x: 3 }, { id: "b" }]);
    const calls: string[][] = [];
    const clock = manual();
    const r = createReactor({
      api: f.api,
      rules: [copyX("A", "a", "b", 0, calls)],
      schedule: clock.schedule,
    });
    expect(clock.pending()).toBe(0);
    r.invalidate(["b", "missing"]);
    expect(clock.pending()).toBe(1);
    clock.frame();
    expect(calls).toEqual([["A", "b"]]);
    expect(f.get("b").x).toBe(3);
    r.dispose();
  });
});
