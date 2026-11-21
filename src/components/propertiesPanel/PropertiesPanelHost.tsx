/**
 * Our sections in Excalidraw's own properties panel (docs/extensions.md § "UI surface").
 *
 * Excalidraw 0.18.1 has no API to add panel sections, so for the current selection each
 * registered section that has something to show is portalled into its own host node inside the
 * panel's `.panelColumn`: "top" sections right after the panel's first slot (where Stroke sits
 * for shapes), "bottom" sections at the end. React only moves its own nodes, so foreign nodes
 * survive panel re-renders; a MutationObserver puts them back when the panel remounts. When no
 * panel is in the DOM (e.g. the mobile layout with its properties sheet closed) the sections show
 * in a small docked island instead.
 *
 * Being outside Excalidraw's React tree, the sections would swallow its shortcuts; keyboard.ts
 * bridges them back. The DOM contract (PANEL_SELECTOR) is pinned by e2e/extensions.spec.ts.
 */
import { useEffect, useMemo, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  computeViews,
  PANEL_SELECTOR,
  type AnyPanelSection,
  type PanelApi,
  type Views,
} from "./panel";
import { bridgePanelKeys, PANEL_HOST_ATTR } from "./keyboard";

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
      el.className = `props-section ${s.testId}`;
      el.dataset.testid = `${s.testId}-native`;
      el.setAttribute(PANEL_HOST_ATTR, "");
      map.set(s.id, el);
    }
    return map;
  }, [sections]);
  const [attached, setAttached] = useState(false);

  useEffect(() => {
    if (!root || !visibleKey) return;
    const ids = new Set(visibleKey.split("\n"));
    const pick = (slot: AnyPanelSection["slot"]) =>
      sections.filter((s) => s.slot === slot && ids.has(s.id)).map((s) => hosts.get(s.id)!);
    const top = pick("top");
    const bottom = pick("bottom");
    const ours = new Set<Element>(hosts.values());
    const sync = () => {
      for (const [id, host] of hosts) if (!ids.has(id)) host.remove();
      const panel = root.querySelector<HTMLElement>(PANEL_SELECTOR);
      if (!panel) {
        for (const host of hosts.values()) host.remove();
        setAttached(false);
        return;
      }
      // Only move what is out of place, so our own insertions settle the observer.
      let prev = Array.from(panel.children).find((c) => !ours.has(c)) ?? null;
      for (const host of top) {
        if (host.parentElement !== panel || host.previousElementSibling !== prev) {
          panel.insertBefore(host, prev ? prev.nextSibling : panel.firstChild);
        }
        prev = host;
      }
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
  const [views, setViews] = useState<Views>(() => computeViews(api, sections));
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let last = JSON.stringify(computeViews(api, sections));
    setViews(JSON.parse(last) as Views);
    return api.onChange(() => {
      const key = JSON.stringify(computeViews(api, sections));
      if (key === last) return;
      last = key;
      setViews(JSON.parse(key) as Views);
    });
  }, [api, sections]);

  const shown = sections.filter((s) => s.id in views);
  const visibleKey = shown.map((s) => s.id).join("\n");

  useEffect(() => {
    setRoot(container.current?.querySelector<HTMLElement>(".excalidraw") ?? null);
  }, [container, visibleKey]);

  const hosts = usePanelHosts(root, sections, visibleKey);
  useEffect(() => (root ? bridgePanelKeys(root) : undefined), [root]);

  if (!shown.length || !root) return null;
  const render = ({ Component, id }: AnyPanelSection) => <Component view={views[id]} api={api} />;
  if (hosts) return <>{shown.map((s) => createPortal(render(s), hosts.get(s.id)!, s.id))}</>;
  const docked = [
    ...shown.filter((s) => s.slot === "top"),
    ...shown.filter((s) => s.slot !== "top"),
  ];
  return createPortal(
    <div className="Island props-dock" data-testid="props-dock" {...{ [PANEL_HOST_ATTR]: "" }}>
      {docked.map((s) => (
        <div
          key={s.id}
          className={`panelColumn props-section ${s.testId}`}
          data-testid={`${s.testId}-dock`}
        >
          {render(s)}
        </div>
      ))}
    </div>,
    root,
  );
}
