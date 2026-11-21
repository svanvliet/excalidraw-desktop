/**
 * Derived-sync "reactor" (docs/reactor-spike.md, plan D-DX1). One per editor (see
 * `src/extensions/components/host.ts`); Components v1 is its first production rule.
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
import { CaptureUpdateAction, mutateElement, newElementWith } from "@excalidraw/excalidraw";
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

/** What changed for one key since the last flush (key-level rules). */
export interface ReconcileChange {
  /** A source element of the key changed (including deletes/undeletes). */
  sourceChanged: boolean;
  /** Target elements of the key that changed locally (including deletes/undeletes). */
  targets: ReadonlySet<string>;
}

export interface ReconcileContext extends DeriveContext {
  /** Every element linked to `key` (sources and targets, deleted included), pending applied. */
  members(key: string): El[];
  /** Write a patch (keys that already match are dropped). */
  patch(id: string, patch: Patch): void;
  /** Insert a new element (z-order: right after `afterId`, else on top). */
  add(el: El, afterId?: string): void;
}

export interface ReactorRule {
  name: string;
  links(el: El): readonly ReactorLink[];
  /**
   * Element-level rule: desired props for `target` given its `source`. Return only what the
   * rule owns; the reactor drops keys that already match, so this must be pure and idempotent.
   */
  derive?(target: El, source: El, ctx: DeriveContext): Patch | null;
  /**
   * Key-level rule: called once per dirty key with every member, and may patch, add or
   * (un)delete members. Deleted targets count as changes here. Must be idempotent.
   */
  reconcile?(key: string, change: ReconcileChange, ctx: ReconcileContext): void;
  /** Called before the reactor (re)seeds, so the rule can drop caches/indexes. */
  reset?(): void;
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
  /**
   * How patches reach the scene. `replace` (default) hands `updateScene` new element objects.
   * `mutate` patches the scene's own objects in place with the exported `mutateElement`
   * (as Excalidraw's drag does), so position-only patches keep the rough.js `ShapeCache`
   * entry (a WeakMap keyed by element object) instead of regenerating every target's shape.
   * See docs/reactor-spike.md § "Point 2".
   */
  apply?: "replace" | "mutate";
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

const SKIP_DIFF = new Set<string>(["version", "versionNonce", "updated"]);

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
  const apply = opts.apply ?? "replace";

  /** Last stamp observed per element. */
  const seen = new Map<string, Stamp>();
  /** Stamps the reactor or a tagged remote apply wrote; ignored once when observed. */
  const expected = new Map<string, Stamp>();
  const dirtyKeys = new Set<string>();
  const dirtyTargets = new Set<string>();
  /** Key-level rules: per rule, per key, what changed. */
  const dirtyRec = new Map<ReactorRule, Map<string, { source: boolean; targets: Set<string> }>>();
  const recRules = rules.filter((r) => r.reconcile);
  const deriveRules = rules.filter((r) => r.derive);
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

  const linksOf = (el: El, only: readonly ReactorRule[] = deriveRules): ReactorLink[] => {
    const out: ReactorLink[] = [];
    for (const r of only) for (const l of r.links(el)) out.push(l);
    return out;
  };

  const markRec = (rule: ReactorRule, link: ReactorLink, id: string) => {
    let byKey = dirtyRec.get(rule);
    if (!byKey) dirtyRec.set(rule, (byKey = new Map()));
    let entry = byKey.get(link.key);
    if (!entry) byKey.set(link.key, (entry = { source: false, targets: new Set() }));
    if (link.role === "source") entry.source = true;
    else entry.targets.add(id);
  };

  const seed = () => {
    seen.clear();
    expected.clear();
    dirtyKeys.clear();
    dirtyTargets.clear();
    dirtyRec.clear();
    for (const r of rules) r.reset?.();
    for (const el of api.getSceneElementsIncludingDeleted()) {
      seen.set(el.id, stamp(el));
      // Lets rules rebuild their indexes (e.g. group → component) without deriving.
      for (const r of recRules) r.links(el);
    }
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
      for (const r of recRules) {
        for (const link of r.links(el)) {
          markRec(r, link, el.id);
          dirty = true;
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
    if (dirtyKeys.size === 0 && dirtyTargets.size === 0 && dirtyRec.size === 0) return;
    const t0 = performance.now();
    const scene = api.getSceneElementsIncludingDeleted();
    const byId = new Map<string, El>();
    /** Inserted by reconcile rules, with the id they go after (null = top). */
    const added: Array<{ el: El; after: string | null }> = [];
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

    if (dirtyRec.size > 0) {
      const recDirty = new Map(dirtyRec);
      dirtyRec.clear();
      for (const [rule, byKey] of recDirty) {
        const members = new Map<string, string[]>();
        const addMember = (el: El) => {
          for (const l of rule.links(el)) {
            let list = members.get(l.key);
            if (!list) members.set(l.key, (list = []));
            if (!list.includes(el.id)) list.push(el.id);
          }
        };
        for (const el of scene) addMember(el);
        const rctx: ReconcileContext = {
          get: ctx.get,
          members: (key) => (members.get(key) ?? []).map((id) => ctx.get(id)!).filter(Boolean),
          patch: (id, p) => {
            const current = ctx.get(id);
            if (!current) return;
            const eff = effectivePatch(current, p);
            if (eff) pending.set(id, newElementWith(current, eff as never));
          },
          add: (el, afterId) => {
            if (ctx.get(el.id)) return;
            pending.set(el.id, el);
            added.push({ el, after: afterId ?? null });
            addMember(el);
          },
        };
        for (const [key, change] of byKey) {
          try {
            rule.reconcile!(key, { sourceChanged: change.source, targets: change.targets }, rctx);
          } catch (err) {
            log.error(`reactor: ${rule.name} failed to reconcile ${key}`, err);
          }
        }
      }
      // Element-level rules may chain off what the key-level rules wrote.
      for (const id of pending.keys())
        for (const l of linksOf(pending.get(id)!)) if (l.role === "source") keys.add(l.key);
    }

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
        for (const rule of deriveRules) {
          const current = ctx.get(target.id)!;
          const want = rule.derive!(current, source, ctx);
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
      const isAdded = (id: string) => !byId.has(id);
      // Clones carrying the new values (and, in mutate mode, the stamps the originals end on).
      const commits = new Map<string, El>();
      const inPlace: Array<{ orig: El; diff: Patch; to: El }> = [];
      for (const [id, el] of pending) {
        if (isAdded(id)) {
          commits.set(id, el);
          continue;
        }
        if (apply !== "mutate") {
          commits.set(id, el);
          continue;
        }
        const orig = byId.get(id)!;
        const diff: Patch = {};
        for (const k of Object.keys(el) as Array<keyof El>)
          if (!SKIP_DIFF.has(k) && el[k] !== orig[k]) diff[k] = el[k];
        const to = newElementWith(orig, diff as never);
        commits.set(id, to);
        inPlace.push({ orig, diff, to });
      }
      for (const el of commits.values()) expected.set(el.id, stamp(el));
      const build = (pick: (el: El) => El) => {
        const next = scene.map(pick);
        for (const { el, after } of added) {
          const latest = pick(el);
          const at = after === null ? -1 : next.findIndex((e) => e.id === after);
          if (at < 0) next.push(latest);
          else next.splice(at + 1, 0, latest);
        }
        return next;
      };
      // The NEVER write goes in with untouched scene objects: updateScene keeps the *snapshot*
      // version of any element whose live object is ahead of it ("uncommitted local edit"), so
      // patching in place first would leave the Store snapshot stale and later commits on the
      // element would be filtered out of history.
      api.updateScene({
        elements: build((el) => commits.get(el.id) ?? el),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (inPlace.length) {
        // mutate: bring the scene's own objects to the committed values and stamps and swap them
        // back in (no store action; same render batch), so their ShapeCache entries survive.
        for (const { orig, diff, to } of inPlace) {
          mutateElement(orig as never, diff as never, false);
          Object.assign(orig, {
            version: to.version,
            versionNonce: to.versionNonce,
            updated: to.updated,
          });
        }
        const originals = new Map(inPlace.map(({ orig }) => [orig.id, orig]));
        api.updateScene({
          elements: build((el) => originals.get(el.id) ?? commits.get(el.id) ?? el),
        });
      }
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
