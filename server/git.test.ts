import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./command";
import { checkpoint } from "./git";
import { preferences } from "../shared/contracts";
import { sweepWithApi } from "./sweep";
import type { PaseoApi } from "@getpaseo/client";
import { StatusStore } from "./status";

const defaults = preferences.schema.parse({});
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "work"), remote = join(base, "remote.git");
  await mkdir(root); await git(base, ["init", "--bare", remote]);
  await git(root, ["init", "-b", "master"]);
  await git(root, ["config", "user.email", "test@example.invalid"]); await git(root, ["config", "user.name", "Overcommitted Test"]);
  await writeFile(join(root, "base.txt"), "original\n");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "initial"]);
  await git(root, ["remote", "add", "origin", remote]); await git(root, ["push", "-u", "origin", "master"]);
  return { base, root, remote, initial: (await git(root, ["rev-parse", "HEAD"])).trim() };
}
const guard = async () => {};
const protectedSettings = { ...defaults, protectBranches: true };

test("stages tracked, untracked, deleted and previously staged files; respects ignores and pushes", async t => {
  const { root, remote } = await fixture(t);
  await writeFile(join(root, ".gitignore"), "secret\n"); await writeFile(join(root, "secret"), "not shipped");
  await writeFile(join(root, "new.txt"), "new\n"); await rm(join(root, "base.txt"));
  const result = await checkpoint(root, ["Implement parser"], guard, false, defaults);
  assert.equal(result.outcome, "pushed");
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), (await git(root, ["rev-parse", "HEAD"])).trim());
  const body = await git(root, ["log", "-1", "--format=%B"]);
  assert.match(body, /Implement parser/); assert.match(body, /base\.txt/); assert.match(body, /new\.txt/);
  await assert.rejects(git(remote, ["show", "master:secret"]));
});

test("protected master is unchanged; new interim branch keeps staged and unstaged contents", async t => {
  const { root, remote, initial } = await fixture(t);
  await writeFile(join(root, "base.txt"), "staged\n"); await git(root, ["add", "."]);
  await writeFile(join(root, "base.txt"), "final unstaged\n");
  await checkpoint(root, ["Update behavior"], guard, false, protectedSettings);
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "overcommitted/master");
  assert.equal((await git(root, ["rev-parse", "master"])).trim(), initial);
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), initial);
  assert.equal(await git(remote, ["show", "overcommitted/master:base.txt"]), "final unstaged\n");
});

test("compatible existing local and remote interim branch fast-forwards without losing dirty work", async t => {
  const { root, remote } = await fixture(t);
  await git(root, ["branch", "overcommitted/master"]); await git(root, ["push", "origin", "overcommitted/master"]);
  await writeFile(join(root, "source.txt"), "source advanced\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "source advanced"]);
  await writeFile(join(root, "base.txt"), "dirty\n");
  await checkpoint(root, [], guard, false, protectedSettings);
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "overcommitted/master");
  assert.equal(await git(remote, ["show", "overcommitted/master:source.txt"]), "source advanced\n");
  assert.equal(await readFile(join(root, "base.txt"), "utf8"), "dirty\n");
});

test("diverged interim branch gets ordinal; diverged remote-only ordinal is not overwritten", async t => {
  const { root, remote, initial } = await fixture(t);
  await git(root, ["switch", "-c", "overcommitted/master"]);
  await writeFile(join(root, "other.txt"), "other branch\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "diverged"]);
  const other = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, ["push", "origin", "HEAD:refs/heads/overcommitted/master-2"]);
  await git(root, ["switch", "master"]); await writeFile(join(root, "dirty.txt"), "safe\n");
  await checkpoint(root, [], guard, false, protectedSettings);
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "overcommitted/master-3");
  assert.equal((await git(root, ["rev-parse", "overcommitted/master"])).trim(), other);
  assert.equal((await git(remote, ["rev-parse", "overcommitted/master-2"])).trim(), other);
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), initial);
});

test("remote-only compatible interim can be reused", async t => {
  const { root, remote } = await fixture(t);
  await git(root, ["push", "origin", "HEAD:refs/heads/overcommitted/master"]);
  await writeFile(join(root, "new.txt"), "new");
  await checkpoint(root, [], guard, false, protectedSettings);
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "overcommitted/master");
  assert.equal(await git(remote, ["show", "overcommitted/master:new.txt"]), "new");
});

test("interim branch occupied by another worktree gets ordinal", async t => {
  const { root, base } = await fixture(t);
  await git(root, ["worktree", "add", "-b", "overcommitted/master", join(base, "other")]);
  await writeFile(join(root, "new.txt"), "new");
  await checkpoint(root, [], guard, false, protectedSettings);
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "overcommitted/master-2");
});

test("interim disabled protects both local branch names and mapped upstream names", async t => {
  const { root, initial } = await fixture(t);
  await git(root, ["switch", "-c", "feature"]);
  await git(root, ["config", "branch.feature.remote", "origin"]); await git(root, ["config", "branch.feature.merge", "refs/heads/master"]);
  await writeFile(join(root, "new.txt"), "new");
  await assert.rejects(checkpoint(root, [], guard, false, { ...protectedSettings, useInterimBranch: false }), /protected/);
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), initial);
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
});

test("protected work without interim routing surfaces a persistent failure without mutation", async t => {
  const { root, remote, initial, base } = await fixture(t);
  await writeFile(join(root, "new.txt"), "protected work\n");
  const api = {
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: [{ projectRootPath: root }] }) },
    terminals: { list: async () => ({ entries: [] }) },
  } as unknown as PaseoApi;
  const blocked = await sweepWithApi(api, 2, { ...protectedSettings, useInterimBranch: false }, false, new AbortController().signal, async () => []);
  assert.equal(blocked[0].outcome, "error");
  assert.match(blocked[0].message, /Work not pushed.*protected.*interim branches are disabled/);
  assert.match(blocked[0].message, /settings/);
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), initial);
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "master");
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), initial);
  const file = join(base, "status.json");
  await new StatusStore(file).record(blocked, false);
  const restored = new StatusStore(file); await restored.load();
  assert.equal(restored.failures[0].directory, root);
  // Changing the setting or previewing a possible route is not a successful push.
  const preview = await sweepWithApi(api, 2, protectedSettings, true, new AbortController().signal, async () => []);
  await restored.record(preview, true);
  assert.equal(restored.failures.length, 1);
  const success = await sweepWithApi(api, 2, protectedSettings, false, new AbortController().signal, async () => []);
  await restored.record(success, false);
  assert.equal(success[0].outcome, "pushed");
  assert.deepEqual(restored.failures, []);
  assert.equal(await git(remote, ["show", "overcommitted/master:new.txt"]), "protected work\n");
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), initial);
});

test("preview never stages, switches, commits or pushes", async t => {
  const { root, initial } = await fixture(t);
  await writeFile(join(root, "new.txt"), "new");
  const result = await checkpoint(root, [], guard, true, protectedSettings);
  assert.equal(result.outcome, "eligible"); assert.match(result.message, /overcommitted\/master/);
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "master");
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), initial);
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
});

test("failed push is retried on clean worktree without another commit", async t => {
  const { root, remote } = await fixture(t);
  const hook = join(remote, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755);
  await writeFile(join(root, "new.txt"), "new");
  await assert.rejects(checkpoint(root, [], guard, false, defaults));
  const committed = (await git(root, ["rev-parse", "HEAD"])).trim();
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  await rm(hook);
  assert.equal((await checkpoint(root, [], guard, false, defaults)).outcome, "pushed");
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), committed);
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), committed);
});

test("registered project with zero agents and zero workspaces is committed and pushed", async t => {
  const { root, remote } = await fixture(t);
  await writeFile(join(root, "unattended.txt"), "unattended\n");
  const api = {
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: [{ projectRootPath: root }] }) },
    terminals: { list: async () => ({ entries: [] }) },
  } as unknown as PaseoApi;
  const reports = await sweepWithApi(api, 2, defaults, false, new AbortController().signal, async () => []);
  assert.equal(reports[0].outcome, "pushed");
  assert.equal(await git(remote, ["show", "master:unattended.txt"]), "unattended\n");
});

test("uninspectable process activity is a warning, not a veto of committing and pushing", async t => {
  const { root, remote } = await fixture(t);
  await writeFile(join(root, "unattended.txt"), "unattended\n");
  const api = {
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: [{ projectRootPath: root }] }) },
    terminals: { list: async () => ({ entries: [] }) },
  } as unknown as PaseoApi;
  const reports = await sweepWithApi(api, 2, defaults, false, new AbortController().signal, async () => { throw new Error("Cannot inspect process"); });
  assert.equal(reports[0].outcome, "pushed");
  assert.match(reports[0].warnings?.join("\n") ?? "", /Cannot inspect process/);
  assert.equal(await git(remote, ["show", "master:unattended.txt"]), "unattended\n");
});

for (const known of ["none", "agent", "workspace", "process"] as const) {
  test(`unknown activity catalogs do not erase positively observed activity (${known})`, async t => {
    const { root, remote, initial } = await fixture(t);
    await writeFile(join(root, "new.txt"), "work to push\n");
    let agentReads = 0, workspaceReads = 0;
    const api = {
      agents: { list: async () => {
        if (known === "agent" && agentReads++ === 0) return { entries: [{ agent: { id: "busy", cwd: root, title: "Known busy agent", status: "running", labels: {}, pendingPermissions: [] } }], pageInfo: { hasMore: false } };
        throw new Error("agent directory unreadable");
      } },
      workspaces: { list: async () => {
        if (known === "workspace" && workspaceReads++ === 0) return { entries: [{ id: "busy-workspace", name: "Known busy workspace", workspaceDirectory: root, status: "running", scripts: [] }], pageInfo: { hasMore: false } };
        throw new Error("workspace directory unreadable");
      } },
      projects: { list: async () => ({ projects: [{ projectRootPath: root }] }) },
      terminals: { list: async () => { throw new Error("terminal directory unreadable"); } },
    } as unknown as PaseoApi;
    const reports = await sweepWithApi(api, 2, defaults, false, new AbortController().signal, async () => ({
      entries: known === "process" ? [{ pid: 101, ppid: 1, cwd: root, agentId: null }] : [],
      warnings: ["a different process was unreadable"],
    }));
    assert.match(reports[0].warnings?.join("\n") ?? "", /directory unreadable/);
    if (known === "none") {
      assert.equal(reports[0].outcome, "pushed");
      assert.equal(await git(remote, ["show", "master:new.txt"]), "work to push\n");
    } else {
      assert.equal(reports[0].outcome, "skipped");
      assert.match(reports[0].message, /Known busy|Process 101/);
      assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), initial);
      assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
      assert.equal((await git(remote, ["rev-parse", "master"])).trim(), initial);
    }
  });
}

test("closed owner and merely-open terminal permit a normal commit and push", async t => {
  const { root, remote } = await fixture(t);
  await writeFile(join(root, "new.txt"), "finished work\n");
  const agent = { id: "closed", title: "Finished work", cwd: root, workspaceId: "w", status: "closed", providerUnavailable: true, updatedAt: new Date().toISOString(), labels: {}, pendingPermissions: [] };
  const api = {
    agents: { list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [{ id: "w", name: "Work", workspaceDirectory: root, status: "failed", scripts: [] }], pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: [{ projectRootPath: root }] }) },
    terminals: { list: async () => ({ entries: [{ id: "t", workspaceId: "w", cwd: root }] }) },
  } as unknown as PaseoApi;
  const shell = { pid: 50, ppid: 2, cwd: root, agentId: null, terminalId: "t", executable: "/usr/bin/bash", argv: ["bash", "-i"], state: "S", tty: 34817, waitChannel: "poll_schedule_timeout.constprop.0" };
  const reports = await sweepWithApi(api, 2, defaults, false, new AbortController().signal, async () => [shell]);
  assert.equal(reports[0].outcome, "pushed");
  assert.equal(await git(remote, ["show", "master:new.txt"]), "finished work\n");
  await writeFile(join(root, "new.txt"), "later work\n");
  const busy = await sweepWithApi(api, 2, defaults, false, new AbortController().signal, async () => [shell, { pid: 51, ppid: 50, cwd: "/tmp", agentId: null }]);
  assert.equal(busy[0].outcome, "skipped");
  assert.match(busy[0].message, /Process/);
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
  assert.equal(await git(remote, ["show", "master:new.txt"]), "finished work\n");
});

test("failed commits are visible errors, remain staged and pending, then retry successfully", async t => {
  const { root, remote, initial, base } = await fixture(t);
  const hook = join(root, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\necho hook-blocked >&2\nexit 1\n"); await chmod(hook, 0o755);
  await writeFile(join(root, "new.txt"), "retry me\n");
  const api = {
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: [{ projectRootPath: root }] }) },
    terminals: { list: async () => ({ entries: [] }) },
  } as unknown as PaseoApi;
  const run = () => sweepWithApi(api, 2, defaults, false, new AbortController().signal, async () => []);
  const failed = await run();
  assert.equal(failed[0].outcome, "error"); assert.match(failed[0].message, /hook-blocked/);
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), initial);
  assert.match(await git(root, ["diff", "--cached", "--name-only"]), /new.txt/);
  assert.equal(JSON.parse(await readFile(join(root, ".git", "overcommitted-pending.json"), "utf8")).branch, "master");
  const store = new StatusStore(join(base, "status.json"));
  await store.record(failed, false);
  const afterRestart = new StatusStore(join(base, "status.json")); await afterRestart.load();
  assert.equal(afterRestart.failures[0].directory, root);
  await rm(hook);
  const success = await run(); await afterRestart.record(success, false);
  assert.equal(success[0].outcome, "pushed"); assert.deepEqual(afterRestart.failures, []);
  assert.equal(await git(remote, ["show", "master:new.txt"]), "retry me\n");
  assert.equal((await git(root, ["rev-list", "--count", "HEAD"])).trim(), "2");
});

test("clean worktree with locally committed work is pushed without creating another commit", async t => {
  const { root, remote } = await fixture(t);
  await writeFile(join(root, "new.txt"), "committed but not pushed\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "local work"]);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  assert.equal((await checkpoint(root, [], guard, false, defaults)).outcome, "pushed");
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), head);
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), head);
  assert.equal((await checkpoint(root, [], guard, false, defaults)).outcome, "clean");
});

test("activity guard failure prevents staging", async t => {
  const { root, initial } = await fixture(t); await writeFile(join(root, "new.txt"), "new");
  await assert.rejects(checkpoint(root, [], async () => { throw new Error("agent woke"); }, false, defaults), /agent woke/);
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), initial);
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
});

test("detached HEAD, missing remote and interrupted git operation never commit", async t => {
  const { root, initial } = await fixture(t); await writeFile(join(root, "new.txt"), "new");
  await writeFile(join(root, ".git", "MERGE_HEAD"), initial);
  await assert.rejects(checkpoint(root, [], guard, false, defaults), /operation in progress/);
  await rm(join(root, ".git", "MERGE_HEAD"));
  await git(root, ["switch", "--detach", initial]);
  await assert.rejects(checkpoint(root, [], guard, false, defaults));
  await git(root, ["switch", "master"]); await git(root, ["remote", "remove", "origin"]);
  await assert.rejects(checkpoint(root, [], guard, false, defaults), /remote/);
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), initial);
});
