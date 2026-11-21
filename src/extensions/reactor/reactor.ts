/**
 * EXPERIMENTAL — derived-sync "reactor" spike (docs/reactor-spike.md, plan D-DX1).
 * Not wired into the app UI. Kept so Components v1 / styles / smart containers can build on
 * the findings; the API may change freely.
 *
 * A reactor watches `api.onChange`, detects LOCAL edits to *source* elements by diffing
 * `version`/`versionNonce`, asks its rules for derived patches to *target* elements, and applies
 * them with `CaptureUpdateAction.NEVER` — the same path remote collab edits take. The user's edit
 * is the only undo step; undoing it changes the source again, which re-derives the targets.
 *
 * - Throttled: at most one flush per animation frame (live during drags).
 * - Loop-guarded: the reactor remembers the exact stamp of everything it (or a tagged remote
 *   apply) wrote and ignores those changes; chained derivations stop after `maxPasses` and an
 *   element is rewritten at most once per flush.
 * - Remote-aware: pass `reactor.wrapRemoteApi(api)` to the collab engine so its applies are tagged
 *   and never re-derived — only the peer that made the edit propagates.
 * - Idempotent: patches that change nothing are dropped, so a duplicate derivation (e.g. an
 *   untagged peer) writes nothing.
 */
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { log } from "../../lib/logger";
import { followBoundArrows } from "./arrows";

export type El = ExcalidrawElement;
export type Patch = Record<string, unknown>;

/** How an element takes part in a rule. One element may be a source and a target (chains). */
export interface ReactorLink {
  role: "source" | "target";
  /** Links targets to their source. One source per key. */
  key: string;
}

export interface DeriveContext {
  /** The element as it will be after this flush (pending patches applied). */
  get(id: string): El | undefined;
}

export interface ReactorRule {
  name: string;
  links(el: El): readonly ReactorLink[];
  /**
   * Desired props for `target` given its `source`. Return only what the rule owns; the reactor
   * drops keys that already match, so this must be pure and idempotent.
   */
  derive(target: El, source: El, ctx: DeriveContext): Patch | null;
}

export type ReactorApi = Pick<
  ExcalidrawImperativeAPI,
  "onChange" | "updateScene" | "getSceneElementsIncludingDeleted"
>;

export interface ReactorStats {
  flushes: number;
  /** Elements written by the reactor (targets + followed arrows). */
  patched: number;
  /** Changes ignored because they were the reactor's own or a tagged remote apply. */
  ignored: number;
  /** Duration of the last flush in ms. */
  lastFlushMs: number;
  /** Longest flush in ms. */
  maxFlushMs: number;
  /** Total time spent in `onChange` diffing, ms. */
  observeMs: number;
  /** Chained derivations cut short by the loop guard. */
  loopGuardHits: number;
}

export interface ReactorOptions {
  api: ReactorApi;
  rules: readonly ReactorRule[];
  /** Defaults to `requestAnimationFrame` (or a 16 ms timeout without one). */
  schedule?: (cb: () => void) => () => void;
  /** Chained derivation depth (a target that is also a source). Default 4. */
  maxPasses?: number;
  /** Move the bound ends of arrows attached to patched targets. Default true. */
  followArrows?: boolean;
}

export interface Reactor {
  /** Run any pending derivation now (tests, or before a save). */
  flush(): void;
  /** Wraps an API so its `updateScene` calls are tagged as remote (never re-derived). */
  wrapRemoteApi<T extends Pick<ExcalidrawImperativeAPI, "updateScene">>(api: T): T;
  /** Forget everything and re-seed from the current scene without deriving (e.g. file open). */
  reseed(): void;
  readonly stats: ReactorStats;
  dispose(): void;
}

type Stamp = string;
const stamp = (el: El): Stamp => `${el.version}:${el.versionNonce}`;

const defaultSchedule = (cb: () => void): (() => void) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
};

const isBoundText = (el: El) =>
  el.type === "text" && !!(el as { containerId?: string | null }).containerId;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keys of `patch` that differ from `el`, or null if none. */
export function effectivePatch(el: El, patch: Patch): Patch | null {
  const rec = el as unknown as Record<string, unknown>;
  let out: Patch | null = null;
  for (const [k, v] of Object.entries(patch)) {
    if (!sameValue(rec[k], v)) (out ??= {})[k] = v;
  }
  return out;
}

export function createReactor(opts: ReactorOptions): Reactor {
  const { api, rules } = opts;
  const schedule = opts.schedule ?? defaultSchedule;
  const maxPasses = opts.maxPasses ?? 4;
  const followArrows = opts.followArrows ?? true;

  /** Last stamp observed per element. */
  const seen = new Map<string, Stamp>();
  /** Stamps the reactor or a tagged remote apply wrote; ignored once when observed. */
  const expected = new Map<string, Stamp>();
  const dirtyKeys = new Set<string>();
  const dirtyTargets = new Set<string>();
  let cancel: (() => void) | null = null;
  let disposed = false;

  const stats: ReactorStats = {
    flushes: 0,
    patched: 0,
    ignored: 0,
    lastFlushMs: 0,
    maxFlushMs: 0,
    observeMs: 0,
    loopGuardHits: 0,
  };

  const linksOf = (el: El): ReactorLink[] => {
    const out: ReactorLink[] = [];
    for (const r of rules) for (const l of r.links(el)) out.push(l);
    return out;
  };

  const seed = () => {
    seen.clear();
    expected.clear();
    dirtyKeys.clear();
    dirtyTargets.clear();
    for (const el of api.getSceneElementsIncludingDeleted()) seen.set(el.id, stamp(el));
  };

  const observe = (elements: readonly El[]) => {
    if (disposed) return;
    const t0 = performance.now();
    let dirty = false;
    for (const el of elements) {
      const s = stamp(el);
      if (seen.get(el.id) === s) continue;
      seen.set(el.id, s);
      const exp = expected.get(el.id);
      if (exp !== undefined) {
        expected.delete(el.id);
        if (exp === s) {
          stats.ignored++;
          continue;
        }
      }
      for (const link of linksOf(el)) {
        if (link.role === "source") {
          dirtyKeys.add(link.key);
          dirty = true;
        } else if (!el.isDeleted) {
          // A local change to a target (new, pasted, undeleted by undo/redo, or edited directly):
          // re-derive it so it can't drift from its source.
          dirtyTargets.add(el.id);
          dirty = true;
        }
      }
    }
    stats.observeMs += performance.now() - t0;
    if (dirty && !cancel) {
      cancel = schedule(() => {
        cancel = null;
        flush();
      });
    }
  };

  const flush = () => {
    if (disposed) return;
    if (cancel) {
      cancel();
      cancel = null;
    }
    if (dirtyKeys.size === 0 && dirtyTargets.size === 0) return;
    const t0 = performance.now();
    const scene = api.getSceneElementsIncludingDeleted();
    const byId = new Map<string, El>();
    const sources = new Map<string, El>();
    const targetsByKey = new Map<string, El[]>();
    const targetKeys = new Map<string, string[]>();
    for (const el of scene) {
      byId.set(el.id, el);
      if (el.isDeleted) continue;
      for (const link of linksOf(el)) {
        if (link.role === "source") {
          sources.set(link.key, el);
          continue;
        }
        let list = targetsByKey.get(link.key);
        if (!list) targetsByKey.set(link.key, (list = []));
        list.push(el);
        let keys = targetKeys.get(el.id);
        if (!keys) targetKeys.set(el.id, (keys = []));
        keys.push(link.key);
      }
    }

    const pending = new Map<string, El>();
    const ctx: DeriveContext = { get: (id) => pending.get(id) ?? byId.get(id) };
    let keys = new Set(dirtyKeys);
    let explicit = new Set(dirtyTargets);
    dirtyKeys.clear();
    dirtyTargets.clear();

    for (let pass = 0; keys.size > 0 || explicit.size > 0; pass++) {
      if (pass >= maxPasses) {
        stats.loopGuardHits++;
        log.warn(`reactor: chained derivation stopped after ${maxPasses} passes`);
        break;
      }
      const work: Array<{ target: El; key: string }> = [];
      for (const key of keys)
        for (const target of targetsByKey.get(key) ?? []) work.push({ target, key });
      for (const id of explicit)
        for (const key of targetKeys.get(id) ?? []) work.push({ target: byId.get(id)!, key });
      // Containers before their bound text, so text layout sees the derived container.
      work.sort((a, b) => Number(isBoundText(a.target)) - Number(isBoundText(b.target)));

      const nextKeys = new Set<string>();
      const touched = new Set<string>();
      const queued = new Set(work.map((w) => w.target.id));
      for (let i = 0; i < work.length; i++) {
        const { target, key } = work[i];
        if (touched.has(target.id)) continue;
        const sourceId = sources.get(key)?.id;
        const source = sourceId ? ctx.get(sourceId) : undefined;
        if (!source) continue; // orphan: left as-is
        for (const rule of rules) {
          const current = ctx.get(target.id)!;
          const want = rule.derive(current, source, ctx);
          const patch = want && effectivePatch(current, want);
          if (!patch) continue;
          if (pass > 0 && pending.has(target.id)) {
            // Rewritten by an earlier pass of this flush: a cycle.
            stats.loopGuardHits++;
            log.warn(`reactor: ${rule.name} would rewrite ${target.id} twice; skipping`);
            continue;
          }
          pending.set(target.id, newElementWith(current, patch as never));
          touched.add(target.id);
          for (const l of linksOf(target)) if (l.role === "source") nextKeys.add(l.key);
        }
        if (!pending.has(target.id)) continue;
        // A patched container's bound text (if it is a target) must be laid out again.
        for (const b of target.boundElements ?? []) {
          if (b.type !== "text" || queued.has(b.id)) continue;
          queued.add(b.id);
          for (const k of targetKeys.get(b.id) ?? [])
            work.push({ target: byId.get(b.id)!, key: k });
        }
      }
      keys = nextKeys;
      explicit = new Set();
    }

    if (followArrows && pending.size > 0) {
      for (const arrow of followBoundArrows(pending, byId)) pending.set(arrow.id, arrow);
    }

    if (pending.size > 0) {
      for (const el of pending.values()) expected.set(el.id, stamp(el));
      api.updateScene({
        elements: scene.map((el) => pending.get(el.id) ?? el),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      stats.patched += pending.size;
    }
    stats.flushes++;
    stats.lastFlushMs = performance.now() - t0;
    stats.maxFlushMs = Math.max(stats.maxFlushMs, stats.lastFlushMs);
  };

  const wrapRemoteApi = <T extends Pick<ExcalidrawImperativeAPI, "updateScene">>(inner: T): T =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop !== "updateScene") return Reflect.get(target, prop, receiver);
        return (data: Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]) => {
          if (data.elements) {
            const current = new Map(api.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
            // Only elements the apply replaces; reconciled local winners keep their identity.
            for (const el of data.elements) {
              if (current.get(el.id) !== el) expected.set(el.id, stamp(el));
            }
          }
          return target.updateScene(data);
        };
      },
    });

  seed();
  const unsubscribe = api.onChange((elements) => observe(elements));

  return {
    flush,
    wrapRemoteApi,
    reseed: seed,
    stats,
    dispose() {
      disposed = true;
      cancel?.();
      cancel = null;
      unsubscribe();
    },
  };
}
