import type { PluginClientContext } from "@getpaseo/plugin/client";
import { statusRpc } from "../shared/contracts";

// Sidebar contributions on Paseo 0.9.1 have static labels. Register a row only
// while there are visible warnings, and update immediately after dismissal.
export function watchFailures(client: PluginClientContext) {
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
    if (count) remove = client.addSidebarItem({ id: "status", title, icon: "TriangleAlert", surface: "status" });
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
