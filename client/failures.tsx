import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { statusRpc } from "../shared/contracts";

// Register only while warnings exist; dismissal refreshes immediately.
export function watchFailures(client: PluginClientContext, Row: ComponentType<PluginSidebarItemProps & { label: string }>) {
  let disposed = false, sequence = 0;
  let remove: (() => void) | undefined;
  let label = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (count: number) => {
    if (disposed) return;
    const title = count ? `Work not pushed (${count})` : "";
    if (label === title) return;
    remove?.(); remove = undefined;
    label = title;
    if (count) remove = client.addSidebarHeaderItem({ id: "status", title: "Work not pushed", Component: props => <Row {...props} label={title} /> });
  };
  const refresh = async () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    const request = ++sequence;
    try {
      const status = await client.rpc(statusRpc, {});
      if (request === sequence) show(status.failures.length);
    } catch {
      // Preserve any already-known warning during a disconnect. Don't invent
      // an undismissable sidebar warning when no failures have been reported.
    } finally {
      if (!disposed && request === sequence) timer = setTimeout(() => { void refresh(); }, 15_000);
    }
  };
  void refresh();
  return {
    refresh,
    dispose() { disposed = true; sequence++; if (timer) clearTimeout(timer); remove?.(); },
  };
}
