import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { agentBlocker, familyIds, snapshot } from "./directory";
import { processBlocker, inside, waitingShell, type ProcessInfo } from "./processes";
import { RateLimitGate, rateLimitUntil } from "./rate-limit";
import { Scheduler } from "./scheduler";
import { preferences } from "../shared/contracts";
import { interimName, protectedNames } from "./branches";

const agent = (id: string, parent?: string, status = "idle") => ({ id, title: id, status, pendingPermissions: [], labels: parent ? { "paseo.parent-agent-id": parent } : {}, updatedAt: new Date(0).toISOString() } as unknown as PaseoAgent);

test("only idle top-level owners qualify; running descendants outside the worktree block", () => {
  const parent = agent("parent"), child = agent("child", "parent", "running");
  assert.equal(agentBlocker([], []), null);
  assert.equal(agentBlocker([parent], [parent]), null);
  assert.match(agentBlocker([parent, child], [parent])!, /not truly idle/);
  assert.match(agentBlocker([agent("child", "parent")], [agent("child", "parent")])!, /Only subagents/);
  const grandchild = agent("grandchild", "child", "running");
  assert.match(agentBlocker([grandchild, agent("child", "parent"), parent], [parent])!, /grandchild/);
  assert.deepEqual([...familyIds([grandchild, child, parent], [parent])].sort(), ["child", "grandchild", "parent"]);
});

test("positively observed active turns, permissions and running/initializing statuses block", () => {
  for (const patch of [{ activeTurn: { turnId: "turn" } }, { pendingPermissions: [{}] }, { status: "running" }, { status: "initializing" }]) {
    const a = { ...agent("a"), ...patch } as PaseoAgent;
    assert.ok(agentBlocker([a], [a]));
  }
});

test("unknown/error agent state and unavailable providers are not evidence of activity", () => {
  for (const patch of [{ status: "error" }, { providerUnavailable: true }, { status: "unknown" }]) {
    const a = { ...agent("a"), ...patch } as PaseoAgent;
    assert.equal(agentBlocker([a], [a]), null);
  }
});

test("closed owners are settled unless they still have an active turn or permission", () => {
  const closed = { ...agent("a"), status: "closed" as const, providerUnavailable: true };
  assert.equal(agentBlocker([closed], [closed]), null);
  for (const patch of [{ activeTurn: { turnId: "turn" } }, { pendingPermissions: [{}] }]) {
    const a = { ...closed, ...patch } as PaseoAgent;
    assert.ok(agentBlocker([a], [a]));
  }
});

test("only an empty interactive terminal prompt is exempt, not scripts, builtins or child jobs", () => {
  const shell: ProcessInfo = { pid: 50, ppid: 2, cwd: "/repo", agentId: null, executable: "/usr/bin/bash", argv: ["bash", "--noprofile", "--norc", "-i"], state: "S", tty: 34817, waitChannel: "poll_schedule_timeout.constprop.0" };
  assert.ok(waitingShell(shell, [shell]));
  assert.equal(processBlocker([shell], "/repo", new Set(), 2, 99), null);
  for (const patch of [{ argv: ["bash", "-c", "do-work"] }, { argv: ["bash", "script.sh"] }, { executable: "/usr/bin/node" }, { state: "R" }, { waitChannel: "do_wait" }, { tty: 0 }]) {
    const busy = { ...shell, ...patch };
    assert.equal(waitingShell(busy, [busy]), false);
    assert.ok(processBlocker([busy], "/repo", new Set(), 2, 99));
  }
  const unknown = { pid: 51, ppid: 50, cwd: null, agentId: null, inspectionIncomplete: true };
  assert.equal(processBlocker([shell, unknown], "/repo", new Set(), 2, 99), null);
  const observedGrandchild = { pid: 52, ppid: 51, cwd: "/tmp", agentId: null };
  assert.ok(processBlocker([shell, unknown, observedGrandchild], "/repo", new Set(), 2, 99));
  const job = { pid: 51, ppid: 50, cwd: "/tmp", agentId: null };
  assert.equal(waitingShell(shell, [shell, job]), false);
  assert.ok(processBlocker([shell, job], "/repo", new Set(), 2, 99));
  // Ownership metadata still catches a terminal command started outside the repo.
  assert.ok(processBlocker([{ ...job, ppid: 1, terminalId: "terminal" }], "/repo", new Set(), 2, 99, new Set(["terminal"])));
});

test("process checks exclude the provider runtime but include descendants and detached tagged jobs", () => {
  const root = { pid: 10, ppid: 2, cwd: "/repo", agentId: "a" };
  assert.equal(processBlocker([root], "/repo", new Set(["a"]), 2, 99), null);
  assert.ok(processBlocker([root, { pid: 11, ppid: 10, cwd: "/tmp", agentId: null }], "/repo", new Set(["a"]), 2, 99));
  assert.ok(processBlocker([{ pid: 11, ppid: 1, cwd: "/tmp", agentId: "a" }], "/repo", new Set(["a"]), 2, 99));
  assert.ok(processBlocker([{ pid: 11, ppid: 1, cwd: "/repo/nested", agentId: null }], "/repo", new Set(), 2, 99));
  assert.ok(processBlocker([{ pid: 11, ppid: 1, cwd: "/tmp", agentId: "archived-agent", agentCwd: "/repo" }], "/repo", new Set(), 2, 99));
  assert.equal(inside("/repo", "/repo-other"), false);
});

test("recorded parent-folder ancestry covers stripped descendants but not plain parent-folder shells", () => {
  const job = { pid: 11, ppid: 10, cwd: "/tmp", agentId: null };
  const launcher = { pid: 10, ppid: 1, cwd: "/tmp", agentId: null, agentCwd: "/work" };
  assert.match(processBlocker([job, launcher], "/work/repo", new Set(), 2, 99)!, /Process 11/);
  assert.equal(processBlocker([job, launcher], "/work-other/repo", new Set(), 2, 99), null);
  assert.equal(processBlocker([{ pid: 12, ppid: 1, cwd: "/work", agentId: null }], "/work/repo", new Set(), 2, 99), null);
});

test("directory pagination includes every page and rejects broken cursors in strict mode", async () => {
  let n = 0;
  const api = { agents: { list: async () => ++n === 1 ? { entries: [{ agent: agent("one") }], pageInfo: { hasMore: true, nextCursor: "two" } } : { entries: [{ agent: agent("two") }], pageInfo: { hasMore: false } } }, workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi;
  assert.deepEqual((await snapshot(api)).agents.map(a => a.id), ["one", "two"]);
  api.agents.list = (async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: null } })) as unknown as typeof api.agents.list;
  await assert.rejects(snapshot(api), /Incomplete directory/);
});

test("rate limits use the longest wait and persist across caller instances", async t => {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-rate-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "wait.json");
  const first = new RateLimitGate(path);
  await first.observe("Retry-After: 300\r\nX-RateLimit-Reset-After: 600\r\n");
  // A second repo/caller is stopped before its next network call, not retried early.
  await assert.rejects(new RateLimitGate(path).check(), /no network request sent/);
  assert.equal(rateLimitUntil('retry_after: 1.5\nRetry-After: 4', 1000), 5000);
  assert.equal(rateLimitUntil('X-RateLimit-Remaining: 0\nX-RateLimit-Reset: 900', 1000), 900000);
  assert.equal(rateLimitUntil('Retry-After: Thu, 01 Jan 1970 00:01:00 GMT', 1000), 60000);
  assert.equal(rateLimitUntil('RateLimit-Reset: 20\n{"retryDelay":"45s"}', 1000), 46000);
});

test("scheduler defaults to hourly, reschedules changes and prevents overlapping runs", async () => {
  let finish!: () => void;
  const scheduler = new Scheduler(async () => { await new Promise<void>(resolve => { finish = resolve; }); return []; });
  const settings = preferences.schema.parse({});
  scheduler.configure(settings);
  assert.ok(Math.abs(Date.parse(scheduler.nextCheck!) - Date.now() - 3600000) < 2000);
  const run = scheduler.run(true);
  await assert.rejects(scheduler.run(true), /already running/);
  scheduler.configure({ ...settings, intervalMinutes: 5 });
  finish(); await run;
  assert.ok(Math.abs(Date.parse(scheduler.nextCheck!) - Date.now() - 300000) < 2000);
  scheduler.configure({ ...settings, enabled: false });
  assert.equal(scheduler.nextCheck, null);
  await assert.rejects(scheduler.run(false), /disabled/);
  await scheduler.stop();
});

test("protected names are exact and comma separated; prefix supports placeholder or simple prefix", () => {
  const settings = preferences.schema.parse({ protectBranches: true, protectedBranches: " main, master , release/stable, " });
  assert.deepEqual([...protectedNames(settings)], ["main", "master", "release/stable"]);
  assert.equal(interimName(settings.interimPrefix, "master"), "overcommitted/master");
  assert.equal(interimName("auto/", "feature/a"), "auto/feature/a");
  assert.equal(protectedNames({ ...settings, protectBranches: false }).size, 0);
});
