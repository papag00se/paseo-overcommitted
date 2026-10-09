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
  await assert.rejects(checkpoint(root, [], guard, false, { ...defaults, saveDetachedHead: false }), /Detached HEAD/);
  await git(root, ["switch", "master"]); await git(root, ["remote", "remove", "origin"]);
  await assert.rejects(checkpoint(root, [], guard, false, defaults), /remote/);
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), initial);
});

async function advanceRemote(base: string, remote: string, file: string, content: string) {
  const other = join(base, `other-${file.replace(/\W/g, "")}`);
  await git(base, ["clone", "-q", remote, other]);
  await git(other, ["config", "user.email", "test@example.invalid"]); await git(other, ["config", "user.name", "Other"]);
  await writeFile(join(other, file), content); await git(other, ["add", "."]); await git(other, ["commit", "-m", `remote ${file}`]);
  await git(other, ["push", "-q", "origin", "master"]);
  return (await git(other, ["rev-parse", "HEAD"])).trim();
}

test("remote that moved ahead without conflicts is merged locally, then pushed", async t => {
  const { root, remote, base } = await fixture(t);
  const theirs = await advanceRemote(base, remote, "remote.txt", "remote work\n");
  await writeFile(join(root, "local.txt"), "local work\n");
  const result = await checkpoint(root, [], guard, false, defaults);
  assert.equal(result.outcome, "pushed");
  assert.equal(await git(remote, ["show", "master:remote.txt"]), "remote work\n");
  assert.equal(await git(remote, ["show", "master:local.txt"]), "local work\n");
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), (await git(root, ["rev-parse", "HEAD"])).trim());
  assert.equal((await git(root, ["merge-base", "--is-ancestor", theirs, "HEAD"])), "");
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  await assert.rejects(readFile(join(root, ".git", "overcommitted-pending.json")));
});

test("conflicting remote changes are an error and change nothing", async t => {
  const { root, remote, base } = await fixture(t);
  const theirs = await advanceRemote(base, remote, "base.txt", "remote edit\n");
  await writeFile(join(root, "base.txt"), "local edit\n");
  await assert.rejects(checkpoint(root, [], guard, false, defaults), /conflict with local work.*left as they are/);
  const local = (await git(root, ["rev-parse", "HEAD"])).trim();
  assert.equal(await git(root, ["show", `${local}:base.txt`]), "local edit\n");
  assert.equal(await git(root, ["rev-list", "--count", "HEAD"]), "2\n");
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), theirs);
  assert.equal(JSON.parse(await readFile(join(root, ".git", "overcommitted-pending.json"), "utf8")).branch, "master");
});

test("a merge that would replace an ignored local file is refused", async t => {
  const { root, remote, base } = await fixture(t);
  await writeFile(join(root, ".git", "info", "exclude"), ".env\n"); await writeFile(join(root, ".env"), "SECRET=local\n");
  const theirs = await advanceRemote(base, remote, ".env", "SECRET=remote\n");
  await writeFile(join(root, "local.txt"), "local work\n");
  await assert.rejects(checkpoint(root, [], guard, false, defaults), /would replace ignored local files \(\.env\).*left as they are/);
  assert.equal(await readFile(join(root, ".env"), "utf8"), "SECRET=local\n");
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  await assert.rejects(readFile(join(root, ".git", "MERGE_HEAD")));
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), theirs);
});

test("unpushed commits already contained in the remote resolve as clean without touching the checkout", async t => {
  const { root, remote, base } = await fixture(t);
  await advanceRemote(base, remote, "remote.txt", "remote work\n");
  await git(root, ["fetch", "-q", "origin"]); await git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, ".git", "overcommitted-pending.json"), JSON.stringify({ branch: "master", remote: "origin", ref: "refs/heads/master" }));
  assert.equal((await checkpoint(root, [], guard, false, defaults)).outcome, "clean");
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), head);
});

async function rejectPushes(remote: string, script: string) {
  const hook = join(remote, "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh\n${script}\n`); await chmod(hook, 0o755);
  return () => rm(hook);
}
const exitedPid = async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn("true"); await new Promise(resolve => child.on("exit", resolve));
  return child.pid!;
};

test("a lock left by a dead process is removed; a live owner's lock and the disabled setting are respected", async t => {
  const { root, remote } = await fixture(t);
  const lock = join(root, ".git", "overcommitted.lock");
  await writeFile(join(root, "new.txt"), "new\n");
  await writeFile(lock, JSON.stringify({ pid: process.ppid, at: new Date().toISOString(), root }));
  await assert.rejects(checkpoint(root, [], guard, false, defaults), /already locked/);
  await writeFile(lock, JSON.stringify({ pid: await exitedPid(), at: new Date().toISOString(), root }));
  await assert.rejects(checkpoint(root, [], guard, false, { ...defaults, removeStaleLock: false }), /already locked/);
  assert.equal((await checkpoint(root, [], guard, false, defaults)).outcome, "pushed");
  assert.equal(await git(remote, ["show", "master:new.txt"]), "new\n");
  await assert.rejects(readFile(lock));
});

test("a push left waiting before a branch switch is finished without switching back", async t => {
  const { root, remote } = await fixture(t);
  const allow = await rejectPushes(remote, "exit 1");
  await writeFile(join(root, "new.txt"), "master work\n");
  await assert.rejects(checkpoint(root, [], guard, false, defaults));
  const waiting = (await git(root, ["rev-parse", "master"])).trim();
  await git(root, ["switch", "-c", "feature"]);
  await allow();
  await assert.rejects(checkpoint(root, [], guard, false, { ...defaults, pushSwitchedBranch: false }), /different branch/);
  await writeFile(join(root, "feature.txt"), "feature work\n");
  const result = await checkpoint(root, [], guard, false, defaults);
  assert.equal(result.outcome, "pushed"); assert.match(result.message, /waiting push of master/);
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), waiting);
  assert.equal(await git(remote, ["show", "feature:feature.txt"]), "feature work\n");
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "feature");
});

test("a waiting push whose branch became protected goes to the interim branch", async t => {
  const { root, remote, initial } = await fixture(t);
  const allow = await rejectPushes(remote, "exit 1");
  await writeFile(join(root, "new.txt"), "work\n");
  await assert.rejects(checkpoint(root, [], guard, false, defaults));
  await allow();
  await assert.rejects(checkpoint(root, [], guard, false, { ...protectedSettings, rerouteNewlyProtected: false }), /protected/);
  assert.equal((await checkpoint(root, [], guard, false, protectedSettings)).outcome, "pushed");
  assert.equal(await git(remote, ["show", "overcommitted/master:new.txt"]), "work\n");
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), initial);
});

test("a branch the remote refuses as protected is pushed to the interim branch instead", async t => {
  const { root, remote, initial } = await fixture(t);
  await rejectPushes(remote, `while read old new ref; do [ "$ref" = refs/heads/master ] && { echo "GH006: Protected branch update failed for refs/heads/master." >&2; exit 1; }; done; exit 0`);
  await writeFile(join(root, "new.txt"), "work\n");
  await assert.rejects(checkpoint(root, [], guard, false, { ...defaults, rerouteServerProtected: false }), /GH006/);
  const result = await checkpoint(root, [], guard, false, defaults);
  assert.equal(result.outcome, "pushed"); assert.match(result.message, /protected on the remote.*overcommitted\/master/);
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "overcommitted/master");
  assert.equal(await git(remote, ["show", "overcommitted/master:new.txt"]), "work\n");
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), initial);
});

test("secret scanning refusals are never routed around", async t => {
  const { root, remote } = await fixture(t);
  await rejectPushes(remote, `echo "GH013: Repository rule violations found. Push cannot contain secrets. Changes must be made through a pull request." >&2; exit 1`);
  await writeFile(join(root, "new.txt"), "work\n");
  await assert.rejects(checkpoint(root, [], guard, false, defaults), /secrets/);
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "master");
});

test("work on a detached HEAD is saved to a new interim branch; a clean detached checkout is left alone", async t => {
  const { root, remote, initial } = await fixture(t);
  await git(root, ["switch", "--detach", initial]);
  assert.equal((await checkpoint(root, [], guard, false, defaults)).outcome, "clean");
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), "");
  await writeFile(join(root, "new.txt"), "detached work\n");
  assert.equal((await checkpoint(root, [], guard, false, defaults)).outcome, "pushed");
  const name = `overcommitted/detached-${initial.slice(0, 7)}`;
  assert.equal((await git(root, ["branch", "--show-current"])).trim(), name);
  assert.equal(await git(remote, ["show", `${name}:new.txt`]), "detached work\n");
  assert.equal((await git(remote, ["rev-parse", "master"])).trim(), initial);
});

test("with remote merging disabled, a moved-ahead remote is reported", async t => {
  const { root, remote, base } = await fixture(t);
  await advanceRemote(base, remote, "remote.txt", "remote work\n");
  await writeFile(join(root, "local.txt"), "local\n");
  await assert.rejects(checkpoint(root, [], guard, false, { ...defaults, mergeRemoteAhead: false }), /rejected|failed to push/);
});

function agentApi(root: string, created: { prompt?: string; cwd: string; config: { provider: string } }[]) {
  return {
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }), create: async (options: typeof created[number]) => { created.push(options); return { id: `agent-${created.length}` }; } },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: [{ projectRootPath: root }] }) },
    terminals: { list: async () => ({ entries: [] }) },
  } as unknown as PaseoApi;
}
const withAgent = { ...defaults, agentResolve: true };

test("conflicts go to one agent per situation when enabled; otherwise they stay errors", async t => {
  const { root, remote, base } = await fixture(t);
  const theirs = await advanceRemote(base, remote, "base.txt", "remote edit\n");
  await writeFile(join(root, "base.txt"), "local edit\n");
  const created: Parameters<typeof agentApi>[1] = [];
  const run = (settings: typeof defaults) => sweepWithApi(agentApi(root, created), 2, settings, false, new AbortController().signal, async () => []);
  assert.equal((await run(defaults))[0].outcome, "error");
  assert.equal(created.length, 0);
  const handed = await run(withAgent);
  assert.equal(handed[0].outcome, "skipped"); assert.match(handed[0].message, /resolve merge conflict.*agent-1/);
  assert.equal(created[0].cwd, root); assert.equal(created[0].config.provider, defaults.agentModel);
  assert.match(created[0].prompt!, new RegExp(`git merge --no-ff ${theirs}`));
  assert.match(created[0].prompt!, /--no-verify/);
  const again = await run(withAgent);
  assert.equal(again[0].outcome, "error"); assert.match(again[0].message, /agent-1 already tried/);
  assert.equal(created.length, 1);
});

test("a failed commit check goes to an agent with the check's output", async t => {
  const { root } = await fixture(t);
  const hook = join(root, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\necho 'lint: missing semicolon in app.js' >&2\nexit 1\n"); await chmod(hook, 0o755);
  await writeFile(join(root, "app.js"), "let x = 1\n");
  const created: Parameters<typeof agentApi>[1] = [];
  const reports = await sweepWithApi(agentApi(root, created), 2, withAgent, false, new AbortController().signal, async () => []);
  assert.equal(reports[0].outcome, "skipped"); assert.match(reports[0].message, /fix failed commit check/);
  assert.match(created[0].prompt!, /missing semicolon/);
  assert.match(await git(root, ["diff", "--cached", "--name-only"]), /app\.js/);
});
