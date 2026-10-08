import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processes, processBlocker, type ProcessInfo } from "./processes";

test("an unreadable process does not discard other positively observed jobs", { skip: process.platform !== "linux" }, async t => {
  const proc = await mkdtemp(join(tmpdir(), "overcommitted-proc-"));
  t.after(() => rm(proc, { recursive: true, force: true }));
  for (const pid of [100, 101]) {
    const dir = join(proc, String(pid)); await mkdir(dir);
    await writeFile(join(dir, "stat"), `${pid} (worker) S 1 0 0 0`);
    await writeFile(join(dir, "cmdline"), "/usr/bin/sleep\0");
    await symlink("/repo", join(dir, "cwd"));
    await symlink("/usr/bin/sleep", join(dir, "exe"));
    await writeFile(join(dir, "wchan"), "hrtimer_nanosleep");
    if (pid === 100) await mkdir(join(dir, "environ")); // Deterministic read error, even as root.
    else await writeFile(join(dir, "environ"), "PASEO_AGENT_CWD=/repo\0");
  }
  const inspection = await processes(proc);
  assert.match(inspection.warnings.join("\n"), /Cannot inspect process 100/);
  assert.match(processBlocker(inspection.entries, "/repo", new Set(), 2, 99)!, /Process 101/);
  assert.equal(processBlocker(inspection.entries.filter(p => p.pid === 100), "/repo", new Set(), 2, 99), null);
});

test("unavailable process table returns uncertainty, not an exception veto", async t => {
  const dir = await mkdtemp(join(tmpdir(), "overcommitted-proc-missing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inspection = await processes(join(dir, "missing"));
  assert.deepEqual(inspection.entries, []);
  assert.ok(inspection.warnings.length);
});

test("unknown provider status does not turn its control runtime into a busy job", () => {
  const runtime = { pid: 10, ppid: 2, cwd: "/repo", agentId: "unknown-agent", agentCwd: "/repo" };
  assert.equal(processBlocker([runtime], "/repo", new Set(), 2, 99), null);
  const job = { pid: 11, ppid: 10, cwd: "/tmp", agentId: null };
  assert.match(processBlocker([runtime, job], "/repo", new Set(), 2, 99)!, /Process 11/);
});

// Real layout: daemon → `node guard/codex.mjs --upstream /x/codex app-server` → `/x/codex app-server`,
// with PASEO_AGENT_CWD=/home (a parent of every repository) and stdio MCP servers.
const daemon = 2;
const guard: ProcessInfo = { pid: 10, ppid: daemon, cwd: "/home", agentId: "a", agentCwd: "/home", executable: "/usr/bin/node", argv: ["/usr/bin/node", "/bridge/guard/codex.mjs", "--upstream", "/x/bin/codex", "app-server"], state: "S", tty: 0, pipes: ["pipe:[1]", "pipe:[2]"] };
const codex: ProcessInfo = { pid: 11, ppid: 10, cwd: "/home", agentId: "a", agentCwd: "/home", executable: "/x/0.1/bin/codex", argv: ["/x/bin/codex", "app-server", "--enable", "goals"], state: "S", tty: 0, stdin: "pipe:[1]", stdout: "pipe:[2]", pipes: ["pipe:[1]", "pipe:[2]", "pipe:[30]", "pipe:[31]"] };
const mcp: ProcessInfo = { pid: 12, ppid: 11, cwd: "/home/repo", agentId: null, executable: "/usr/bin/node", argv: ["/usr/bin/node", "/bridge/mcp/server.mjs"], state: "S", tty: 0, stdin: "pipe:[30]", stdout: "pipe:[31]" };

test("an exec-wrapped provider runtime with its idle stdio tool servers is not a job", () => {
  assert.equal(processBlocker([guard, codex], "/home/repo", new Set(), daemon, 99), null);
  assert.equal(processBlocker([guard, codex, mcp], "/home/repo", new Set(["a"]), daemon, 99), null);
});

test("wrapped runtime jobs and tool-server children still block", () => {
  const shell: ProcessInfo = { pid: 13, ppid: 11, cwd: "/tmp", agentId: "a", executable: "/usr/bin/bash", argv: ["bash", "-lc", "npm test"], state: "S", tty: 0, stdin: "pipe:[30]", stdout: "pipe:[31]" };
  assert.match(processBlocker([guard, codex, shell], "/home/repo", new Set(), daemon, 99)!, /Process 13/);
  const spawned: ProcessInfo = { pid: 14, ppid: 12, cwd: "/tmp", agentId: null, executable: "/usr/bin/chromium", argv: ["chromium"], state: "S", tty: 0 };
  assert.match(processBlocker([guard, codex, mcp, spawned], "/home/repo", new Set(), daemon, 99)!, /Process 14/);
  // A same-agent child the launcher did not name is a job, not a wrapped runtime.
  const script: ProcessInfo = { ...codex, pid: 15, executable: "/usr/bin/node", argv: ["node", "build.js"], stdin: null, stdout: null };
  assert.match(processBlocker([guard, script], "/home/repo", new Set(), daemon, 99)!, /Process 15/);
});

test("a tool-server exemption needs a sleeping, terminal-less child on pipes held by its runtime", () => {
  for (const patch of [{ state: "R" }, { tty: 34817 }, { stdin: "pipe:[99]" }, { stdout: null }, { executable: "/usr/bin/sh" }, { ppid: 1 }]) {
    assert.match(processBlocker([guard, codex, { ...mcp, ...patch }], "/home/repo", new Set(["a"]), daemon, 99)!, /Process 12/, JSON.stringify(patch));
  }
  // A child of an ordinary (non-runtime) process gets no exemption.
  const job: ProcessInfo = { pid: 20, ppid: 1, cwd: "/home/repo", agentId: null, pipes: ["pipe:[30]", "pipe:[31]"] };
  assert.match(processBlocker([job, { ...mcp, ppid: 20 }], "/home/repo", new Set(), daemon, 99)!, /Process/);
});

test("process inspection records stdio pipes and pipes held by agent-tagged processes", { skip: process.platform !== "linux" }, async t => {
  const proc = await mkdtemp(join(tmpdir(), "overcommitted-proc-fd-"));
  t.after(() => rm(proc, { recursive: true, force: true }));
  const dir = join(proc, "300"); await mkdir(join(dir, "fd"), { recursive: true });
  await writeFile(join(dir, "stat"), "300 (codex) S 2 0 0 0");
  await writeFile(join(dir, "cmdline"), "/x/bin/codex\0app-server\0");
  await writeFile(join(dir, "environ"), "PASEO_AGENT_ID=a\0");
  await writeFile(join(dir, "wchan"), "futex_do_wait");
  await symlink("/repo", join(dir, "cwd")); await symlink("/x/bin/codex", join(dir, "exe"));
  await symlink("pipe:[7]", join(dir, "fd", "0")); await symlink("/dev/null", join(dir, "fd", "1")); await symlink("pipe:[8]", join(dir, "fd", "9"));
  const [entry] = (await processes(proc)).entries;
  assert.equal(entry.stdin, "pipe:[7]");
  assert.equal(entry.stdout, null);
  assert.deepEqual(entry.pipes?.sort(), ["pipe:[7]", "pipe:[8]"]);
});
