import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processes, processBlocker } from "./processes";

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
