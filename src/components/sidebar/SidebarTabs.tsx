/**
 * Host for the app's extra tabs in Excalidraw's own default sidebar (plan D-DX4). Each tab adds a
 * trigger next to the built-in Search / Library triggers and a panel rendered by Excalidraw's
 * `Sidebar.Tab`, so it docks, themes and closes exactly like the native tabs. Later features
 * (e.g. Components) register here by adding a {@link SidebarTabDef}.
 */
import { DefaultSidebar, Sidebar, useI18n } from "@excalidraw/excalidraw";
import type { ReactNode } from "react";
import { LibraryIcon } from "../icons";
import { useSettingsStore } from "../../stores/settingsStore";
import { reopenTab } from "./sidebarTabMemory";

export interface SidebarTabDef {
  /** Tab id; open it with `api.toggleSidebar({ name: "default", tab })`. */
  tab: string;
  /** Tooltip and accessible name of the trigger. */
  title: string;
  icon: ReactNode;
  /** Panel content; only mounted while the tab is selected. */
  render: () => ReactNode;
}

export const DEFAULT_SIDEBAR = "default";

export function SidebarTabs({ tabs }: { tabs: readonly SidebarTabDef[] }) {
  return (
    <>
      <LibraryTrigger tabs={tabs} />
      <DefaultSidebarWithTabs tabs={tabs} />
    </>
  );
}

/**
 * Replaces Excalidraw's fallback Library button (same look and label) so it reopens the sidebar
 * on the last-used tab instead of always on Library (FR-68; see sidebarTabMemory.ts).
 */
function LibraryTrigger({ tabs }: { tabs: readonly SidebarTabDef[] }) {
  const { t } = useI18n();
  const remembered = useSettingsStore((s) => s.sidebarTab);
  const tab = reopenTab(
    remembered,
    tabs.map((d) => d.tab),
  );
  const label = t("toolBar.library");
  return (
    <DefaultSidebar.Trigger icon={<LibraryIcon />} title={label} tab={tab}>
      {label}
    </DefaultSidebar.Trigger>
  );
}

function DefaultSidebarWithTabs({ tabs }: { tabs: readonly SidebarTabDef[] }) {
  return (
    <DefaultSidebar>
      <DefaultSidebar.TabTriggers>
        {tabs.map((t) => (
          <Sidebar.TabTrigger
            key={t.tab}
            tab={t.tab}
            title={t.title}
            aria-label={t.title}
            data-testid={`sidebar-tab-${t.tab}`}
          >
            {t.icon}
          </Sidebar.TabTrigger>
        ))}
      </DefaultSidebar.TabTriggers>
      {tabs.map((t) => (
        <Sidebar.Tab key={t.tab} tab={t.tab} className="desktop-sidebar-tab">
          {t.render()}
        </Sidebar.Tab>
      ))}
    </DefaultSidebar>
  );
}
