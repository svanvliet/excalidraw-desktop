/**
 * Our sections in Excalidraw's own properties panel (docs/extensions.md § "UI surface").
 *
 * Excalidraw 0.18.1 has no API to add panel sections, so for the current selection each
 * registered section that has something to show is portalled into its own host node inside the
 * panel's `.panelColumn`: "top" sections first, as the rows of a compact strip above Excalidraw's
 * own controls (FR-63, D-DX17: single-open accordion, see StripRow and stores/panelStripStore),
 * "bottom" sections at the end. React only moves its own nodes, so foreign nodes
 * survive panel re-renders; a MutationObserver puts them back when the panel remounts. When no
 * panel is in the DOM (e.g. the mobile layout with its properties sheet closed) the sections show
 * in a small docked island instead.
 *
 * Rows gated by progressive disclosure (FR-65, D-DX19: `inUse` / `more`) are offered from a "+"
 * row after the last row instead; picking one reveals that row for the current selection.
 *
 * Being outside Excalidraw's React tree, the sections would swallow its shortcuts; keyboard.ts
 * bridges them back. The DOM contract (PANEL_SELECTOR) is pinned by e2e/extensions.spec.ts.
 */
import { useEffect, useMemo, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  computeViews,
  PANEL_SELECTOR,
  selectionKey,
  stripLayout,
  type AnyPanelSection,
  type PanelApi,
  type Views,
} from "./panel";
import { bridgePanelKeys, PANEL_HOST_ATTR } from "./keyboard";
import { MORE_TEST_ID, StripMore, StripRow } from "./controls";
import { usePanelStripStore } from "../../stores/panelStripStore";

const rowClass = (s: AnyPanelSection) =>
  s.slot === "top" ? "props-strip__row" : `props-section ${s.testId}`;
const LAST_ROW = "props-strip__row--last";
/** Host id of the "+" row (not a section id). */
const MORE = "\u0000more";

/**
 * Keeps one host node per visible section in the native panel, in registration order. Returns
 * the hosts once attached, or null when there is no native panel (use the dock).
 */
function usePanelHosts(
  root: HTMLElement | null,
  sections: readonly AnyPanelSection[],
  visibleKey: string,
): Map<string, HTMLElement> | null {
  const hosts = useMemo(() => {
    const map = new Map<string, HTMLElement>();
    for (const s of sections) {
      const el = document.createElement("div");
      el.className = rowClass(s);
      el.dataset.testid = `${s.testId}-native`;
      el.setAttribute(PANEL_HOST_ATTR, "");
      map.set(s.id, el);
    }
    const more = document.createElement("div");
    more.className = "props-strip__row";
    more.dataset.testid = `${MORE_TEST_ID}-native`;
    more.setAttribute(PANEL_HOST_ATTR, "");
    map.set(MORE, more);
    return map;
  }, [sections]);
  const [attached, setAttached] = useState(false);

  useEffect(() => {
    if (!root || !visibleKey) return;
    const ids = new Set(visibleKey.split("\n"));
    const pick = (slot: AnyPanelSection["slot"]) =>
      sections.filter((s) => s.slot === slot && ids.has(s.id)).map((s) => hosts.get(s.id)!);
    const top = pick("top");
    if (ids.has(MORE)) top.push(hosts.get(MORE)!);
    const bottom = pick("bottom");
    const sync = () => {
      for (const [id, host] of hosts) if (!ids.has(id)) host.remove();
      const panel = root.querySelector<HTMLElement>(PANEL_SELECTOR);
      if (!panel) {
        for (const host of hosts.values()) host.remove();
        setAttached(false);
        return;
      }
      // Only move what is out of place, so our own insertions settle the observer.
      let prev: Element | null = null;
      top.forEach((host, i) => {
        if (host.parentElement !== panel || host.previousElementSibling !== prev) {
          panel.insertBefore(host, prev ? prev.nextSibling : panel.firstChild);
        }
        host.classList.toggle(LAST_ROW, i === top.length - 1);
        prev = host;
      });
      let next: Element | null = null;
      for (const host of [...bottom].reverse()) {
        if (host.parentElement !== panel || host.nextElementSibling !== next) {
          panel.insertBefore(host, next);
        }
        next = host;
      }
      setAttached(true);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const host of hosts.values()) host.remove();
      setAttached(false);
    };
  }, [root, sections, hosts, visibleKey]);

  return visibleKey && attached ? hosts : null;
}

interface Snapshot {
  views: Views;
  sel: string;
}

const snapshot = (api: PanelApi, sections: readonly AnyPanelSection[]): Snapshot => ({
  views: computeViews(api, sections),
  sel: selectionKey(api),
});

export function PropertiesPanelHost({
  api,
  container,
  sections,
}: {
  api: PanelApi;
  /** Wrapper around `<Excalidraw>`; the host looks for `.excalidraw` inside it. */
  container: RefObject<HTMLElement | null>;
  /** Registration order is display order within a slot. Keep the array identity stable. */
  sections: readonly AnyPanelSection[];
}) {
  const [{ views, sel }, setState] = useState<Snapshot>(() => snapshot(api, sections));
  const [root, setRoot] = useState<HTMLElement | null>(null);
  // Rows revealed from "+", for the selection they were revealed on.
  const [revealed, setRevealed] = useState<{ sel: string; ids: string[] }>({ sel: "", ids: [] });

  useEffect(() => {
    let last = JSON.stringify(snapshot(api, sections));
    setState(JSON.parse(last) as Snapshot);
    return api.onChange(() => {
      const key = JSON.stringify(snapshot(api, sections));
      if (key === last) return;
      last = key;
      setState(JSON.parse(key) as Snapshot);
    });
  }, [api, sections]);

  const { shown, more } = stripLayout(
    sections,
    views,
    new Set(revealed.sel === sel ? revealed.ids : []),
  );
  const visibleKey = [...shown.map((s) => s.id), ...(more.length ? [MORE] : [])].join("\n");

  useEffect(() => {
    setRoot(container.current?.querySelector<HTMLElement>(".excalidraw") ?? null);
  }, [container, visibleKey]);

  const hosts = usePanelHosts(root, sections, visibleKey);
  useEffect(() => (root ? bridgePanelKeys(root) : undefined), [root]);
  const open = usePanelStripStore((s) => s.open);
  const toggle = usePanelStripStore((s) => s.toggle);
  const setOpen = usePanelStripStore((s) => s.setOpen);

  if (!visibleKey || !root) return null;
  const pick = (testId: string) => {
    const hit = more.find((m) => m.section.testId === testId);
    if (!hit) return;
    if (hit.entry.run) return hit.entry.run(api);
    const keep = revealed.sel === sel ? revealed.ids : [];
    setRevealed({ sel, ids: [...keep, hit.section.id] });
    setOpen(hit.section.id);
  };
  const moreRow = (
    <StripMore
      entries={more.map((m) => ({ testId: m.section.testId, ...m.entry }))}
      onPick={pick}
    />
  );
  const render = (s: AnyPanelSection) => {
    if (s.slot === "top") {
      return (
        <StripRow
          section={s}
          view={views[s.id]}
          api={api}
          open={open === s.id}
          onToggle={() => toggle(s.id)}
        />
      );
    }
    const { Component } = s;
    return Component ? <Component view={views[s.id]} api={api} /> : null;
  };
  if (hosts) {
    return (
      <>
        {shown.map((s) => createPortal(render(s), hosts.get(s.id)!, s.id))}
        {more.length > 0 && createPortal(moreRow, hosts.get(MORE)!, MORE)}
      </>
    );
  }
  const top = shown.filter((s) => s.slot === "top");
  const docked = [...top, ...shown.filter((s) => s.slot !== "top")];
  const dockClass = (s: AnyPanelSection) =>
    s.slot !== "top"
      ? `panelColumn ${rowClass(s)}`
      : s === top[top.length - 1] && !more.length
        ? `${rowClass(s)} ${LAST_ROW}`
        : rowClass(s);
  return createPortal(
    <div className="Island props-dock" data-testid="props-dock" {...{ [PANEL_HOST_ATTR]: "" }}>
      {top.map((s) => (
        <div key={s.id} className={dockClass(s)} data-testid={`${s.testId}-dock`}>
          {render(s)}
        </div>
      ))}
      {more.length > 0 && (
        <div className={`props-strip__row ${LAST_ROW}`} data-testid={`${MORE_TEST_ID}-dock`}>
          {moreRow}
        </div>
      )}
      {docked.slice(top.length).map((s) => (
        <div key={s.id} className={dockClass(s)} data-testid={`${s.testId}-dock`}>
          {render(s)}
        </div>
      ))}
    </div>,
    root,
  );
}
