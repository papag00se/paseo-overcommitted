import { createPaseoClient, type PaseoAgent, type PaseoApi, type PaseoWorkspace } from "@getpaseo/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { command, git } from "./command";

export interface Snapshot { agents: PaseoAgent[]; workspaces: PaseoWorkspace[] }
export const parentId = (a: PaseoAgent) => a.labels["paseo.parent-agent-id"]?.trim() || null;
export async function snapshot(api: PaseoApi, onUnknown?: (warning: string) => void, previous?: Snapshot): Promise<Snapshot> {
  const agents: PaseoAgent[] = [], workspaces: PaseoWorkspace[] = [];
  for (const kind of ["agents", "workspaces"] as const) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      try {
        const result = kind === "agents" ? await api.agents.list({ page: { limit: 200, cursor } }) : await api.workspaces.list({ page: { limit: 200, cursor } });
        if (kind === "agents") agents.push(...(result as Awaited<ReturnType<PaseoApi["agents"]["list"]>>).entries.map(e => e.agent));
        else workspaces.push(...(result as Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>).entries);
        if (!result.pageInfo.hasMore) break;
        cursor = result.pageInfo.nextCursor ?? undefined;
        if (!cursor || seen.has(cursor)) throw new Error("Incomplete directory pagination");
        seen.add(cursor);
      } catch (error) {
        if (!onUnknown) throw error;
        onUnknown(`${kind} activity is incomplete: ${(error as Error).message}`);
        if (previous && kind === "agents") {
          const refreshed = new Set(agents.map(a => a.id));
          agents.push(...previous.agents.filter(a => !refreshed.has(a.id)));
        } else if (previous && kind === "workspaces") {
          const refreshed = new Set(workspaces.map(w => w.id));
          workspaces.push(...previous.workspaces.filter(w => !refreshed.has(w.id)));
        }
        break; // Retain already-observed activity; still query the other catalog.
      }
    } while (cursor);
  }
  return { agents, workspaces };
}
// Activity sources (e.g. parent-folder agents) may block a repository, but do
// not establish ownership or make a subagent-only repository eligible.
export function agentBlocker(agents: PaseoAgent[], related: PaseoAgent[], activitySources: PaseoAgent[] = []): string | null {
  if (related.length && !related.some(a => !parentId(a))) return "Only subagents own this worktree";
  const ids = familyIds(agents, [...related, ...activitySources]);
  for (const a of agents.filter(a => ids.has(a.id))) {
    if (a.status === "running" || a.status === "initializing" || a.activeTurn || a.pendingPermissions.length) return `Agent ${a.title || a.id} is not truly idle (${a.status})`;
  }
  return null;
}
export function familyIds(agents: PaseoAgent[], related: PaseoAgent[]): Set<string> {
  const ids = new Set(related.map(a => a.id));
  for (let n = -1; n !== ids.size;) {
    n = ids.size;
    for (const a of agents) if (parentId(a) && ids.has(parentId(a)!)) ids.add(a.id);
  }
  return ids;
}
export async function rootOf(cwd: string): Promise<string | null> {
  try { return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim(); }
  catch { return null; }
}

// 0.11.2 exposes a PaseoApi in server callbacks, not entry startup.
// A short-lived, daemon-local SDK connection makes the timer work with zero agents
// and zero connected UI clients. Never inherits PASEO_HOST from a launching agent.
export function localDaemonConnection(state: Record<string, unknown>, owner: { pid: number; parentPid: number } | null) {
  const isPid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (!isPid(state.pid) || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(String(state.listen))) throw new Error("Overcommitted requires a local loopback Paseo daemon");
  if (state.workerPid !== undefined && !isPid(state.workerPid)) throw new Error("Invalid Paseo worker identity");
  // The IPC parent is the authoritative owner. CLI workerPid is optional:
  // its provider-health RPC can time out while the published instance is live.
  if (owner) {
    if (!isPid(owner.pid) || (owner.pid !== state.pid && owner.parentPid !== state.pid) ||
        (state.workerPid !== undefined && state.workerPid !== owner.pid)) {
      throw new Error("PASEO_HOME resolves to a different daemon than this plugin's owner; refusing to operate on it");
    }
    return { url: `ws://${state.listen}/ws`, daemonPid: owner.pid };
  }
  if (!isPid(state.workerPid)) throw new Error("Cannot establish Paseo worker identity without the plugin's owning IPC connection");
  return { url: `ws://${state.listen}/ws`, daemonPid: state.workerPid };
}

export async function connectLocal() {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const state = JSON.parse(await command("paseo", ["daemon", "status", "--json", "--home", home]));
  let owner: { pid: number; parentPid: number } | null = null;
  if (process.send) {
    if (!process.connected) throw new Error("Plugin's owning IPC connection is closed; refusing to operate");
    const pid = process.ppid;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    owner = { pid, parentPid: Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[1]) };
  }
  const { url, daemonPid } = localDaemonConnection(state, owner);
  const client = createPaseoClient({ url, reconnect: { enabled: false }, connectTimeoutMs: 15_000 });
  try { await client.connect(); } catch (e) { await client.close(); throw e; }
  return { client, daemonPid };
}
