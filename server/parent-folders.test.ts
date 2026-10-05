import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { git } from "./command";
import { sweepWithApi } from "./sweep";
import type { ProcessInfo } from "./processes";
import { preferences, type Report } from "../shared/contracts";

const settings = preferences.schema.parse({});
const daemonPid = 200;
const runtimePid = 201;
const jobPid = 202;

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-parent-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const parent = join(base, "Work");
  const child = join(parent, "known-a"), sibling = join(parent, "known-b");
  const unknown = join(parent, "not-registered"), outside = join(base, "Work-other", "known-c");
  const repositories = new Map<string, { head: string; remote: string }>();
  for (const [n, root] of [child, sibling, unknown, outside].entries()) {
    await mkdir(root, { recursive: true });
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "overcommitted-test@example.invalid"]);
    await git(root, ["config", "user.name", "Overcommitted Test"]);
    await writeFile(join(root, "file.txt"), "original\n");
    await git(root, ["add", "."]); await git(root, ["commit", "-m", "fixture"]);
    const remote = join(base, `remote-${n}.git`);
    // Local clone seeds a disposable remote without executing a push.
    await git(base, ["clone", "--bare", root, remote]);
    await git(root, ["remote", "add", "origin", remote]);
    const hook = join(root, ".git", "hooks", "pre-push");
    await writeFile(hook, '#!/bin/sh\necho unexpected > "$(git rev-parse --absolute-git-dir)/unexpected-push"\nexit 1\n');
    await chmod(hook, 0o755);
    await writeFile(join(root, "file.txt"), "uncommitted changes\n");
    await writeFile(join(root, "new.txt"), "untracked changes\n");
    repositories.set(root, { head: (await git(root, ["rev-parse", "HEAD"])).trim(), remote });
  }
  const parentAgent = {
    id: "parent", title: "Parent folder agent", cwd: parent, workspaceId: "parent-workspace",
    status: "idle", labels: {}, activeTurn: null, pendingPermissions: [], updatedAt: new Date(0).toISOString(),
  } as unknown as PaseoAgent;
  const api = (agents: PaseoAgent[] = [parentAgent], registered = [child, sibling, outside]) => ({
    agents: { list: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [{ id: "parent-workspace", name: "Parent", workspaceDirectory: parent, status: "done", scripts: [] }], pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: registered.map(projectRootPath => ({ projectRootPath })) }) },
    terminals: { list: async () => ({ entries: [] }) },
  }) as unknown as PaseoApi;
  const runtime: ProcessInfo = { pid: runtimePid, ppid: daemonPid, agentId: parentAgent.id, cwd: parent, agentCwd: parent };
  const run = (processes: ProcessInfo[], agents = [parentAgent], preview = true, registered?: string[]) =>
    sweepWithApi(api(agents, registered), daemonPid, settings, preview, new AbortController().signal, async () => processes);
  const reportFor = (reports: Report[], root: string) => { const report = reports.find(r => r.directory === root); assert.ok(report, `Missing report for ${root}`); return report; };
  async function untouched(root: string) {
    const before = repositories.get(root)!;
    assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), before.head, "must not commit");
    assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "", "must not stage");
    assert.equal(await readFile(join(root, "file.txt"), "utf8"), "uncommitted changes\n");
    assert.equal(await readFile(join(root, "new.txt"), "utf8"), "untracked changes\n");
    assert.equal((await git(before.remote, ["rev-parse", "main"])).trim(), before.head, "remote must stay unchanged");
    await assert.rejects(access(join(root, ".git", "unexpected-push")), { code: "ENOENT" });
  }
  return { parent, child, sibling, unknown, outside, parentAgent, runtime, api, run, reportFor, untouched, repositories };
}

for (const kind of ["parent-cwd job", "detached job outside all repositories", "environment-stripped descendant"] as const) {
  test(`idle parent: ${kind} blocks every affected known child before staging`, async t => {
    const f = await fixture(t);
    const job: ProcessInfo = kind === "environment-stripped descendant"
      ? { pid: jobPid, ppid: runtimePid, agentId: null, cwd: "/tmp" }
      : { pid: jobPid, ppid: 1, agentId: "parent", cwd: kind === "parent-cwd job" ? f.parent : "/tmp" };
    // Mutation-enabled path, but only blocked known repos; any attempted push hits a rejecting hook.
    const reports = await f.run([f.runtime, job], [f.parentAgent], false, [f.child, f.sibling]);
    for (const root of [f.child, f.sibling]) {
      const report = f.reportFor(reports, root);
      assert.equal(report.outcome, "skipped");
      assert.match(report.message, /Process 202 is still associated/);
      await f.untouched(root);
    }
    assert.ok(!reports.some(r => r.directory === f.unknown), "must not discover repo subfolders");
    await f.untouched(f.unknown);
  });
}

test("quiet parent control runtime alone permits known children, with no discovery expansion", async t => {
  const f = await fixture(t);
  const reports = await f.run([f.runtime]);
  for (const root of [f.child, f.sibling, f.outside]) assert.equal(f.reportFor(reports, root).outcome, "eligible");
  assert.deepEqual(new Set(reports.map(r => r.directory)), new Set([f.parent, f.child, f.sibling, f.outside]));
  for (const root of [f.child, f.sibling, f.unknown, f.outside]) await f.untouched(root);
});

test("parent job does not block an unrelated or prefix-sibling repository", async t => {
  const f = await fixture(t);
  const reports = await f.run([f.runtime, { pid: jobPid, ppid: 1, agentId: "parent", agentCwd: f.parent, cwd: "/tmp" }]);
  assert.equal(f.reportFor(reports, f.child).outcome, "skipped");
  assert.equal(f.reportFor(reports, f.sibling).outcome, "skipped");
  assert.equal(f.reportFor(reports, f.outside).outcome, "eligible");
  assert.ok(!reports.some(r => r.directory === f.unknown));
});

test("recorded parent agent cwd blocks children even after the agent disappears", async t => {
  const f = await fixture(t);
  const reports = await f.run([{ pid: jobPid, ppid: 1, agentId: "gone", agentCwd: f.parent, cwd: "/tmp" }], [], false, [f.child, f.sibling]);
  for (const root of [f.child, f.sibling]) {
    assert.match(f.reportFor(reports, root).message, /Process 202 is still associated/);
    await f.untouched(root);
  }
});

test("out-of-folder delegated descendant job blocks its idle parent folder's known children", async t => {
  const f = await fixture(t);
  const delegated = { ...f.parentAgent, id: "delegated", cwd: "/tmp", workspaceId: undefined, labels: { "paseo.parent-agent-id": "parent" } };
  const reports = await f.run([{ pid: jobPid, ppid: 1, agentId: "delegated", cwd: "/tmp" }], [f.parentAgent, delegated], false, [f.child]);
  assert.match(f.reportFor(reports, f.child).message, /Process 202 is still associated/);
  await f.untouched(f.child);
});

test("running delegated descendant still blocks when its parent is idle in an ancestor folder", async t => {
  const f = await fixture(t);
  const delegated = { ...f.parentAgent, id: "delegated", title: "Delegated job", cwd: "/tmp", status: "running" as const, workspaceId: undefined, labels: { "paseo.parent-agent-id": "parent" } };
  const reports = await f.run([], [f.parentAgent, delegated], false, [f.child]);
  assert.match(f.reportFor(reports, f.child).message, /Delegated job.*not truly idle/);
  await f.untouched(f.child);
});

test("closed parent is not an owner but its surviving jobs still block", async t => {
  const f = await fixture(t);
  const closed = { ...f.parentAgent, status: "closed" as const };
  const quiet = await f.run([], [closed]);
  assert.equal(f.reportFor(quiet, f.child).outcome, "eligible");
  const busy = await f.run([{ pid: jobPid, ppid: 1, agentId: "parent", cwd: "/tmp" }], [closed], false, [f.child]);
  assert.match(f.reportFor(busy, f.child).message, /Process 202 is still associated/);
  await f.untouched(f.child);
});

test("parent activity scope never promotes a subagent-only repository into an eligible owner", async t => {
  const f = await fixture(t);
  const child = { ...f.parentAgent, id: "child", cwd: f.child, labels: { "paseo.parent-agent-id": "parent" } };
  const reports = await f.run([], [f.parentAgent, child], false, [f.child]);
  assert.match(f.reportFor(reports, f.child).message, /Only subagents/);
  await f.untouched(f.child);
});

test("a parent-folder job appearing after eligibility is rechecked before staging", async t => {
  const f = await fixture(t);
  const reports = await sweepWithApi(f.api([f.parentAgent], [f.child]), daemonPid, settings, false, new AbortController().signal, async () => {
    // Initial eligibility runs before the checkpoint takes its repository lock.
    const checkpointStarted = await access(join(f.child, ".git", "overcommitted.lock")).then(() => true, () => false);
    return checkpointStarted ? [f.runtime, { pid: jobPid, ppid: 1, agentId: "parent", cwd: "/tmp" }] : [f.runtime];
  });
  assert.match(f.reportFor(reports, f.child).message, /Process 202 is still associated/);
  await f.untouched(f.child);
});

test("a parent-folder job appearing at the pre-push guard blocks the push", async t => {
  const f = await fixture(t);
  const before = f.repositories.get(f.child)!;
  const reports = await sweepWithApi(f.api([f.parentAgent], [f.child]), daemonPid, settings, false, new AbortController().signal, async () => {
    // Expose the race by observable repository state, not by counting guard calls.
    const committed = (await git(f.child, ["rev-parse", "HEAD"])).trim() !== before.head;
    return committed ? [f.runtime, { pid: jobPid, ppid: 1, agentId: "parent", cwd: "/tmp" }] : [f.runtime];
  });
  assert.match(f.reportFor(reports, f.child).message, /Process 202 is still associated/);
  assert.notEqual((await git(f.child, ["rev-parse", "HEAD"])).trim(), before.head, "checkpoint was committed before the job appeared");
  assert.equal((await git(before.remote, ["rev-parse", "main"])).trim(), before.head);
  await assert.rejects(access(join(f.child, ".git", "unexpected-push")), { code: "ENOENT" });
  assert.ok(JSON.parse(await readFile(join(f.child, ".git", "overcommitted-pending.json"), "utf8")), "push remains pending");
});
