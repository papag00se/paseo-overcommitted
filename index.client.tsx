import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Settings } from "./client/settings";
import { watchFailures } from "./client/failures";
import { Warnings } from "./client/warnings";

export default function contribute(client: PluginClientContext) {
  let refreshWarnings = () => {};
  client.addSurface("status", props => <Warnings {...props} onDismissed={() => refreshWarnings()} />);
  client.addSettingsScreen({ id: "overcommitted", title: "Settings", icon: "GitCommitHorizontal", Component: Settings });
  client.addCommandCenterItem({ id: "settings", title: "Overcommitted settings", icon: "GitCommitHorizontal", context: "global", onSelect: ({ openSettings }) => openSettings("overcommitted") });
  const indicator = watchFailures(client);
  refreshWarnings = () => { void indicator.refresh(); };
  return () => indicator.dispose();
}
