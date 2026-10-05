import type { PluginServerContext } from "@getpaseo/plugin/server";
import { checkRpc, dismissWarningsRpc, preferences, statusRpc } from "./shared/contracts";
import { Scheduler } from "./server/scheduler";
import { sweep } from "./server/sweep";
import { StatusStore } from "./server/status";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const status = new StatusStore();
  const scheduler = new Scheduler(sweep, status);
  const restored = scheduler.restore();
  let disposed = false;
  const unsubscribe = settings.subscribe(state => {
    if (!disposed && state.status === "ready") scheduler.configure(state.values);
  });
  void restored.then(() => settings.read()).then(state => {
    if (state.status !== "ready") throw new Error(state.error);
    if (!disposed) scheduler.configure(state.values);
  }).catch(e => console.error("Overcommitted settings unavailable; no commits will run", e));
  server.handle(statusRpc, async () => { await restored; return { running: scheduler.running, nextCheck: scheduler.nextCheck, reports: scheduler.reports, failures: scheduler.failures }; });
  server.handle(dismissWarningsRpc, async ({ warnings }) => { await restored; return { dismissed: await status.dismiss(warnings) }; });
  server.handle(checkRpc, async ({ preview }) => { await restored; return { reports: await scheduler.run(preview) }; });
  return async () => { disposed = true; unsubscribe(); await scheduler.stop(); };
}
