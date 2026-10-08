import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { relative, isAbsolute, basename } from "node:path";

export interface ProcessInfo {
  pid: number; ppid: number; cwd: string | null; agentId: string | null; agentCwd?: string | null;
  terminalId?: string | null; workspaceId?: string | null;
  executable?: string; argv?: string[]; state?: string; tty?: number; waitChannel?: string;
  inspectionIncomplete?: boolean;
  /** Pipe ids of fd 0/1 (null if not a pipe), and every pipe held (agent-tagged processes only). */
  stdin?: string | null; stdout?: string | null; pipes?: string[];
}
export interface ProcessInspection { entries: ProcessInfo[]; warnings: string[] }
export type ProcessInspector = () => Promise<ProcessInspection | ProcessInfo[]>;

// Do not exempt shells executing -c commands/scripts, running builtins, waiting
// for a job, or with child processes. Only a leaf interactive shell waiting for
// terminal input is a merely-open terminal.
export function waitingShell(p: ProcessInfo, all: ProcessInfo[]): boolean {
  return !!p.executable && SHELLS.includes(basename(p.executable)) &&
    !!p.argv?.length && p.argv.slice(1).every(arg => ["-i", "-l", "-il", "-li", "--login", "--noprofile", "--norc", "--interactive"].includes(arg)) &&
    p.state === "S" && !!p.tty && /^(n_tty_read|wait_woken|do_select|poll_schedule_timeout(?:[.$].*)?)$/.test(p.waitChannel ?? "") &&
    !all.some(child => child.ppid === p.pid && !child.inspectionIncomplete);
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}
const SHELLS = ["bash", "zsh", "fish", "sh", "dash", "ksh"];
const pipeId = (link: string) => /^pipe:\[\d+\]$/.test(link) ? link : null;
async function fdPipe(path: string): Promise<string | null> {
  try { return pipeId(await readlink(path)); } catch { return null; }
}
async function heldPipes(path: string): Promise<string[]> {
  const pipes: string[] = [];
  for (const fd of await readdir(`${path}/fd`).catch(() => [] as string[])) {
    const id = await fdPipe(`${path}/fd/${fd}`);
    if (id) pipes.push(id);
  }
  return pipes;
}
const vanished = (e: unknown) => ["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "");

export async function processes(procRoot = "/proc"): Promise<ProcessInspection> {
  const entries: ProcessInfo[] = [], warnings: string[] = [];
  if (process.platform !== "linux") return { entries, warnings: ["Process activity is unknown: Linux /proc is unavailable"] };
  let names: string[];
  try { names = await readdir(procRoot); }
  catch (error) { return { entries, warnings: [`Process activity is unknown: ${(error as Error).message}`] }; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const path = `${procRoot}/${name}`;
    let basic: ProcessInfo | undefined;
    try {
      if ((await stat(path)).uid !== process.getuid!()) continue;
      const text = await readFile(`${path}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") continue;
      basic = { pid: Number(name), ppid: Number(fields[1]), cwd: null, agentId: null, inspectionIncomplete: true };
      // The login user's service manager is deliberately non-dumpable. It is
      // infrastructure, not an agent job; its children are still inspected.
      const cmdline = await readFile(`${path}/cmdline`, "utf8");
      if (fields[1] === "1" && cmdline === "/usr/lib/systemd/systemd\0--user\0") continue;
      if (cmdline.replaceAll("\0", "").trim() === "(sd-pam)" &&
          (await readFile(`${procRoot}/${fields[1]}/cmdline`, "utf8")) === "/usr/lib/systemd/systemd\0--user\0") continue;
      const environment = await readFile(`${path}/environ`, "utf8");
      let cwd: string | null;
      try { cwd = await readlink(`${path}/cwd`); } catch (e) { if (!vanished(e)) throw e; cwd = null; }
      const agentId = environment.split("\0").find(x => x.startsWith("PASEO_AGENT_ID="))?.slice(15) || null;
      entries.push({ pid: Number(name), ppid: Number(fields[1]), cwd, agentId,
        agentCwd: environment.split("\0").find(x => x.startsWith("PASEO_AGENT_CWD="))?.slice(16) || null,
        terminalId: environment.split("\0").find(x => x.startsWith("PASEO_TERMINAL_ID="))?.slice(18) || null,
        workspaceId: environment.split("\0").find(x => x.startsWith("PASEO_WORKSPACE_ID="))?.slice(19) || null,
        executable: await readlink(`${path}/exe`), argv: cmdline.split("\0").filter(Boolean),
        state: fields[0], tty: Number(fields[4]), waitChannel: (await readFile(`${path}/wchan`, "utf8")).trim(),
        stdin: await fdPipe(`${path}/fd/0`), stdout: await fdPipe(`${path}/fd/1`),
        ...(agentId ? { pipes: await heldPipes(path) } : {}),
      });
    } catch (e) {
      if (!vanished(e)) {
        warnings.push(`Cannot inspect process ${name}; activity is unknown (${(e as Error).message})`);
        // Retain ancestry links so another, positively observed job is still
        // attributable through this unreadable process. Unknown alone is no veto.
        if (basic) entries.push(basic);
      }
    }
  }
  return { entries, warnings };
}

// A launcher (e.g. a guard script run as `node guard.mjs --upstream /path/codex …`)
// that names the program it spawned. The child carries the same agent identity.
function launchedBy(parent: ProcessInfo, child: ProcessInfo): boolean {
  const args = parent.argv?.slice(1) ?? [];
  return !!child.agentId && child.agentId === parent.agentId &&
    [child.argv?.[0], child.executable].some(name => !!name && args.includes(name));
}
/**
 * Provider control runtimes: the daemon's direct agent-tagged children, plus any
 * program those launchers exec-wrap. Their own jobs are still not exempt.
 */
export function providerRuntimes(all: ProcessInfo[], daemonPid: number): Set<number> {
  const byPid = new Map(all.map(p => [p.pid, p]));
  const runtime = new Set(all.filter(p => p.ppid === daemonPid && p.agentId && !p.inspectionIncomplete).map(p => p.pid));
  for (let n = -1; n !== runtime.size;) {
    n = runtime.size;
    for (const p of all) {
      const parent = byPid.get(p.ppid);
      if (!p.inspectionIncomplete && !runtime.has(p.pid) && parent && runtime.has(parent.pid) && launchedBy(parent, p)) runtime.add(p.pid);
    }
  }
  return runtime;
}
/**
 * An idle stdio tool server (MCP server, code-mode host) of a provider runtime:
 * a sleeping, non-shell, terminal-less direct child whose stdin and stdout are
 * both pipes held by that runtime. Anything it spawns is still a job.
 */
export function idleStdioServer(p: ProcessInfo, runtime: Set<number>, byPid: Map<number, ProcessInfo>): boolean {
  const parent = byPid.get(p.ppid);
  return !!parent && runtime.has(parent.pid) && !p.tty && p.state === "S" &&
    !!p.executable && !SHELLS.includes(basename(p.executable)) &&
    !!p.stdin && !!p.stdout && p.stdin !== p.stdout && !!parent.pipes?.includes(p.stdin) && parent.pipes.includes(p.stdout);
}

export function processBlocker(all: ProcessInfo[], root: string, agentIds: Set<string>, daemonPid: number, selfPid = process.pid, terminalIds = new Set<string>(), workspaceIds = new Set<string>()): string | null {
  const byPid = new Map(all.map(p => [p.pid, p]));
  // Only daemon-owned provider runtimes (through exec-style launchers) and their
  // idle stdio tool servers are control infrastructure. Shell commands, children
  // of tool servers, detached jobs and unknown helper processes block.
  const runtime = providerRuntimes(all, daemonPid);
  // Recorded agent cwd remains useful for detached jobs after the agent is
  // archived/deleted. A parent folder covers its known child repositories;
  // an ordinary untagged shell cwd does not establish that relationship.
  const associated = (p: ProcessInfo) => (!!p.cwd && inside(root, p.cwd)) || (!!p.agentId && agentIds.has(p.agentId)) ||
    (!!p.terminalId && terminalIds.has(p.terminalId)) || (!!p.workspaceId && workspaceIds.has(p.workspaceId)) ||
    (!!p.agentCwd && (inside(root, p.agentCwd) || inside(p.agentCwd, root)));
  for (const p of all) {
    if (p.inspectionIncomplete || p.pid === selfPid || runtime.has(p.pid) || p.pid === daemonPid || waitingShell(p, all) || idleStdioServer(p, runtime, byPid)) continue;
    let belongs = associated(p);
    const seen = new Set<number>();
    for (let parent = byPid.get(p.ppid); parent && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
      seen.add(parent.pid);
      if (associated(parent)) belongs = true;
    }
    if (belongs || (p.cwd && inside(root, p.cwd))) return `Process ${p.pid} is still associated with this worktree or an agent`;
  }
  return null;
}
