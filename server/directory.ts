import { createPaseoClient, type PaseoAgent, type PaseoApi, type PaseoWorkspace } from "@getpaseo/client";
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

// 0.9.1 does not expose a PaseoApi on server entry startup, only in callbacks.
// A short-lived, daemon-local SDK connection makes the timer work with zero agents
// and zero connected UI clients. Never inherits PASEO_HOST from a launching agent.
export async function connectLocal() {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const state = JSON.parse(await command("paseo", ["daemon", "status", "--json", "--home", home]));
  if (!state.workerPid || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(state.listen)) throw new Error("Overcommitted requires a local loopback Paseo daemon");
  if (process.send && process.ppid !== state.workerPid) throw new Error("PASEO_HOME resolves to a different daemon than this plugin's owner; refusing to operate on it");
  const client = createPaseoClient({ url: `ws://${state.listen}/ws`, reconnect: { enabled: false }, connectTimeoutMs: 15_000 });
  try { await client.connect(); } catch (e) { await client.close(); throw e; }
  return { client, daemonPid: state.workerPid as number };
}
