import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Settings } from "./client/settings";
import { watchFailures } from "./client/failures";
import { Warnings } from "./client/warnings";

function FailureRow({ label, currentScreen, openScreen }: PluginSidebarItemProps & { label: string }) {
  return <SidebarRow icon="TriangleAlert" label={label} active={currentScreen?.screenId === "status"} onPress={() => openScreen({ screenId: "status" })} />;
}

export default function contribute(client: PluginClientContext) {
  let refreshWarnings = () => {};
  client.addScreen({ id: "status", title: "Work not pushed", Component: props => <Warnings {...props} onDismissed={() => refreshWarnings()} /> });
  client.addSettingsScreen({ id: "overcommitted", title: "Settings", icon: "GitCommitHorizontal", Component: Settings });
  client.addCommandCenterItem({ id: "settings", title: "Overcommitted settings", icon: "GitCommitHorizontal", context: "global", onSelect: ({ openSettings }) => openSettings("overcommitted") });
  const indicator = watchFailures(client, FailureRow);
  refreshWarnings = () => { void indicator.refresh(); };
  return () => indicator.dispose();
}
