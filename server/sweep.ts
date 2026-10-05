import type { PaseoApi } from "@getpaseo/client";
import type { Preferences, Report } from "../shared/contracts";
import { agentBlocker, connectLocal, familyIds, parentId, rootOf, snapshot, type Snapshot } from "./directory";
import { inside, processBlocker, processes, type ProcessInspector } from "./processes";
import { checkpoint } from "./git";
import { ActivityBlocked } from "./activity";

export async function sweep(settings: Preferences, preview: boolean, signal: AbortSignal): Promise<Report[]> {
  const { client, daemonPid } = await connectLocal();
  try { return await sweepWithApi(client, daemonPid, settings, preview, signal); }
  finally { await client.close(); }
}
export async function sweepWithApi(api: PaseoApi, daemonPid: number, settings: Preferences, preview: boolean, signal: AbortSignal, inspectProcesses: ProcessInspector = processes): Promise<Report[]> {
  const reports: Report[] = [];
  const initialWarnings = new Set<string>();
  const initial = await snapshot(api, warning => initialWarnings.add(warning));
  const projects = await api.projects.list().catch(error => {
    initialWarnings.add(`Project listing unavailable; checking known agent/workspace directories: ${(error as Error).message}`);
    return { projects: [] };
  });
  const roots = new Map<string, string | null>();
  const root = async (cwd: string) => {
    if (!roots.has(cwd)) roots.set(cwd, await rootOf(cwd));
    return roots.get(cwd)!;
  };
  const directories = new Set<string>();
  for (const cwd of new Set([...projects.projects.map(p => p.projectRootPath), ...initial.workspaces.map(w => w.workspaceDirectory), ...initial.agents.filter(a => !parentId(a)).map(a => a.cwd)])) {
    const r = await root(cwd);
    if (r) directories.add(r);
    else reports.push({ at: new Date().toISOString(), directory: cwd, outcome: "skipped", message: "Not an accessible Git worktree" });
  }
  for (const directory of directories) {
    if (signal.aborted) break;
    const warnings = new Set(initialWarnings);
    let lastSnapshot = initial;
    const fresh = async () => (lastSnapshot = await snapshot(api, warning => warnings.add(warning), lastSnapshot));
    try {
      const validate = async (state: Snapshot) => {
        if (signal.aborted) throw new Error("Check cancelled");
        const related = [];
        for (const a of state.agents) {
          if (await root(a.cwd) === directory || inside(directory, a.cwd)) related.push(a);
        }
        // Scope activity independently of ownership and lifecycle status. An
        // idle/closed parent can still have jobs or delegated agents elsewhere.
        // This filters already-known repositories; it never discovers children.
        const parentFolderAgents = state.agents.filter(a => inside(a.cwd, directory));
        const reason = agentBlocker(state.agents, related, parentFolderAgents);
        if (reason) throw new ActivityBlocked(reason);
        const family = familyIds(state.agents, [...related, ...parentFolderAgents]);
        for (const a of state.agents.filter(a => family.has(a.id))) {
          if (a.status === "error" || (a.providerUnavailable && a.status !== "closed")) warnings.add(`Agent ${a.title || a.id} has unknown activity (${a.status}); no active turn was observed`);
        }
        const workspaceIds = new Set(state.agents.filter(a => family.has(a.id)).map(a => a.workspaceId).filter((id): id is string => !!id));
        for (const w of state.workspaces) {
          if (await root(w.workspaceDirectory) !== directory && !workspaceIds.has(w.id)) continue;
          workspaceIds.add(w.id);
          if (["running", "needs_input"].includes(w.status) || w.archivingAt) throw new ActivityBlocked(`Workspace ${w.name} is ${w.status} or archiving`);
          if (w.scripts.some(s => s.lifecycle === "running")) throw new ActivityBlocked(`Workspace ${w.name} still has a running script`);
        }
        const terminals = await api.terminals.list().catch(error => {
          warnings.add(`Terminal activity is unknown: ${(error as Error).message}`);
          return { entries: [] };
        });
        const terminalIds = new Set(terminals.entries.filter(t => workspaceIds.has(t.workspaceId) || inside(directory, t.cwd)).map(t => t.id));
        const inspection = await inspectProcesses().catch(error => ({ entries: [], warnings: [`Process activity is unknown: ${(error as Error).message}`] }));
        const entries = Array.isArray(inspection) ? inspection : inspection.entries;
        if (!Array.isArray(inspection)) for (const warning of inspection.warnings) warnings.add(warning);
        const blocking = processBlocker(entries, directory, family, daemonPid, process.pid, terminalIds, workspaceIds);
        if (blocking) throw new ActivityBlocked(blocking);
        return related.filter(a => !parentId(a)).map(a => a.title || a.id);
      };
      const titles = await validate(await fresh());
      const guard = async () => { await validate(await fresh()); };
      const result = await checkpoint(directory, titles, guard, preview, settings, signal);
      reports.push({ at: new Date().toISOString(), directory, ...result, warnings: [...warnings].slice(0, 30) });
    } catch (e) {
      reports.push({ at: new Date().toISOString(), directory, outcome: e instanceof ActivityBlocked ? "skipped" : "error", message: (e as Error).message.slice(0, 3000), warnings: [...warnings].slice(0, 30) });
    }
  }
  if (!directories.size && initialWarnings.size) reports.push({ at: new Date().toISOString(), directory: "daemon", outcome: "error", message: "No Git repositories could be identified from the available Paseo directory data", warnings: [...initialWarnings].slice(0, 30) });
  return reports;
}
