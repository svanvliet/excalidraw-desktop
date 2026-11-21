/**
 * Host for the app's extra tabs in Excalidraw's own default sidebar (plan D-DX4). Each tab adds a
 * trigger next to the built-in Search / Library triggers and a panel rendered by Excalidraw's
 * `Sidebar.Tab`, so it docks, themes and closes exactly like the native tabs. Later features
 * (Components, Styles) register here by adding a {@link SidebarTabDef}.
 */
import { DefaultSidebar, Sidebar } from "@excalidraw/excalidraw";
import type { ReactNode } from "react";

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
