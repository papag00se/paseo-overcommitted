import { access, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./command";
import { protectedNames, selectInterim } from "./branches";
import type { Preferences } from "../shared/contracts";
import { Resolvable } from "./agent";
import { acquireLock } from "./lock";

interface Pending { branch: string; remote: string; ref: string }
async function exists(path: string) { try { await access(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
async function config(root: string, key: string) {
  // --get exits 1 for absent keys; --get-regexp isn't necessary for exact names.
  const all = (await git(root, ["config", "--null", "--list"])).split("\0");
  return all.filter(s => s.slice(0, s.indexOf("\n")) === key).at(-1)?.split("\n").slice(1).join("\n") ?? "";
}
export async function pushTarget(root: string, branch: string): Promise<Pending> {
  const remotes = (await git(root, ["remote"])).trim().split("\n").filter(Boolean);
  const upstream = branch ? await config(root, `branch.${branch}.remote`) : "";
  const remote = upstream || (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : "");
  if (!remote || remote === "." || !remotes.includes(remote)) throw new Error("No unambiguous push remote; configure a branch upstream or origin");
  const ref = upstream ? await config(root, `branch.${branch}.merge`) : `refs/heads/${branch}`;
  if (!ref.startsWith("refs/heads/")) throw new Error("Upstream is not a remote branch");
  return { branch, remote, ref };
}
export function commitMessage(names: string[], summary: string, titles: string[]): string {
  const clean = (s: string) => s.replace(/[\r\n\x00-\x1f]/g, " ").trim();
  const subject = titles.length ? clean(titles.join("; ")).slice(0, 90) : `save unattended changes in ${names.length} files`;
  return `chore(overcommitted): ${subject}\n\nAutomatic checkpoint after idle checks.\n\n${summary.trim()}\n\nChanged paths:\n${names.slice(0, 100).map(n => `- ${JSON.stringify(n)}`).join("\n")}${names.length > 100 ? `\n... and ${names.length - 100} more` : ""}\n`;
}
const isAncestor = (root: string, a: string, b: string) => git(root, ["merge-base", "--is-ancestor", a, b]).then(() => true, () => false);
const head = async (root: string) => (await git(root, ["rev-parse", "HEAD"])).trim();
// True when something on disk occupies `path` or a parent folder of it is a file.
async function blocksPath(root: string, path: string) {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(join(root, ...parts.slice(0, i))).catch(e => { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; });
    if (!stat) return false;
    if (i === parts.length || !stat.isDirectory()) return true;
  }
  return false;
}
// The destination's current tip, or null when the remote cannot be reached.
async function fetchTip(root: string, target: Pending, signal?: AbortSignal): Promise<string | null> {
  if (!await git(root, ["fetch", "--no-tags", "--", target.remote, target.ref], signal).then(() => true, () => false)) return null;
  return (await git(root, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
}
const where = (target: Pending) => `${target.remote}/${target.ref.slice("refs/heads/".length)}`;
// After a rejected push: fetch the destination and, only when Git proves the
// merge is conflict-free and touches no ignored files, merge it locally.
// Returns the commit to push, "contained" when the remote already has our work,
// or null when the remote did not move (the rejection had another cause).
async function integrateRemote(root: string, target: Pending, commit: string, check: () => Promise<void>, signal?: AbortSignal): Promise<string | "contained" | null> {
  const theirs = await fetchTip(root, target, signal);
  if (!theirs || await isAncestor(root, theirs, commit)) return null;
  if (await isAncestor(root, commit, theirs)) return "contained";
  // Dry run: computes the merge in the object store without touching files.
  const tree = (await git(root, ["merge-tree", "--write-tree", commit, theirs]).catch(() => {
    const detail = `${where(target)} has new commits that conflict with local work on ${target.branch}.`;
    throw new Resolvable(`Work not pushed: ${detail} Local commits were left as they are; merge manually.`, "conflict", `${commit}:${theirs}`, detail);
  })).trim();
  // Everything is committed, so only untracked (ignored) files could be lost:
  // Git silently replaces them when the merge adds the same path.
  const added = (await git(root, ["diff-tree", "-r", "--name-only", "--diff-filter=A", "-z", commit, tree])).split("\0").filter(Boolean);
  const clobbered = [];
  for (const path of added) if (await blocksPath(root, path)) clobbered.push(path);
  if (clobbered.length) throw new Error(`Work not pushed: merging ${where(target)} would replace ignored local files (${clobbered.slice(0, 5).join(", ")}). Local commits were left as they are; merge manually.`);
  await check();
  if (await head(root) !== commit) throw new Error("HEAD moved before merge");
  await git(root, ["merge", "--no-edit", "--no-stat", "-m", `chore(overcommitted): merge ${where(target)} before push`, theirs], signal).catch(async error => {
    if (await exists(join((await git(root, ["rev-parse", "--absolute-git-dir"])).trim(), "MERGE_HEAD"))) await git(root, ["merge", "--abort"]);
    throw new Error(`Work not pushed: merging ${where(target)} failed and was undone: ${(error as Error).message}`);
  });
  return head(root);
}
// Explicit refspec: ignores push.default, push refspecs, and matching-branch config.
// No force, pull, rebase, reset, stash, or hook bypass.
const pushCommit = (root: string, target: Pending, commit: string, signal?: AbortSignal) =>
  git(root, ["-c", "push.followTags=false", "-c", `remote.${target.remote}.mirror=false`, "push", "--porcelain", "--", target.remote, `${commit}:${target.ref}`], signal);
// Hosts refusing a push because the branch is protected (GitHub branch
// protection and rulesets, GitLab, Bitbucket). Secret scanning also uses
// rulesets and must never be routed around.
const SERVER_PROTECTED = /GH006: Protected branch|protected branch hook declined|Changes must be made through a pull request|not allowed to push code to protected branches|can only be modified through pull requests/i;
export const refusedAsProtected = (message: string) => SERVER_PROTECTED.test(message) && !/secret/i.test(message);
// Identity and signing problems need the user's credentials, not code changes.
const NOT_A_CHECK = /Please tell me who you are|user\.(name|email)|gpg|signing|ssh-keygen/i;
const isProtected = (settings: Preferences, target: Pending) => {
  const names = protectedNames(settings);
  return names.has(target.branch) || names.has(target.ref.replace(/^refs\/heads\//, ""));
};
// A push that was waiting when someone switched branches: push that branch's
// current tip. Needs no checkout, so the current branch is untouched.
async function finishWaitingPush(root: string, pending: Pending, settings: Preferences, signal?: AbortSignal) {
  if (isProtected(settings, pending)) throw new Error(`A waiting push of ${pending.branch} now targets a protected branch; push it manually`);
  const tip = (await git(root, ["rev-parse", "--verify", `refs/heads/${pending.branch}^{commit}`]).catch(() => {
    throw new Error(`A push was waiting for ${pending.branch}, which no longer exists. Check that its work is safe, then delete overcommitted-pending.json in the Git folder.`);
  })).trim();
  await pushCommit(root, pending, tip, signal).catch(async error => {
    const theirs = await fetchTip(root, pending, signal);
    if (!theirs || !await isAncestor(root, tip, theirs)) throw new Error(`Work not pushed: the waiting push of ${pending.branch} failed: ${(error as Error).message}`);
  });
}
export interface GitResult { outcome: "pushed" | "clean" | "eligible"; message: string }
export async function checkpoint(root: string, titles: string[], guard: () => Promise<void>, preview: boolean, settings: Preferences, signal?: AbortSignal): Promise<GitResult> {
  const common = (await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const dir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
  const lockPath = join(common, "overcommitted.lock");
  const lock = await acquireLock(lockPath, root, settings.removeStaleLock);
  try {
    const pendingPath = join(dir, "overcommitted-pending.json");
    const journal = async (target: Pending) => {
      await writeFile(`${pendingPath}.tmp`, JSON.stringify(target), { mode: 0o600 });
      await rename(`${pendingPath}.tmp`, pendingPath);
    };
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG", "index.lock"]) {
      if (await exists(join(dir, marker))) throw new Error(`Git operation in progress (${marker})`);
    }
    if ((await git(root, ["ls-files", "-u"])).trim()) throw new Error("Unmerged paths");
    let branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
    const initialHead = (await git(root, ["rev-parse", "--verify", "HEAD" ]).catch(() => "")).trim();
    const porcelain = await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if (porcelain.split("\0").some(line => /^[12] /.test(line) && /^S/.test(line.split(" ")[2]))) throw new Error("Submodule changes require a separate commit/push; refusing a partial checkpoint");
    const dirty = porcelain.length > 0;
    let pending: Pending | null = await exists(pendingPath) ? JSON.parse(await readFile(pendingPath, "utf8")) : null;
    let resumed = "";
    if (pending && pending.branch !== branch) {
      if (!settings.pushSwitchedBranch) throw new Error("A pending push belongs to a different branch; switch back to it, or enable “Finish a waiting push after a branch switch”");
      if (!preview) { await finishWaitingPush(root, pending, settings, signal); await unlink(pendingPath); }
      resumed = `Finished the waiting push of ${pending.branch}. `;
      pending = null;
    }
    const route = async (label: string, remote: string): Promise<Pending> => {
      const name = await selectInterim(root, label, remote, settings, guard, preview);
      if (!preview) {
        await git(root, ["config", "--local", `branch.${name}.remote`, remote]);
        await git(root, ["config", "--local", `branch.${name}.merge`, `refs/heads/${name}`]);
      }
      return { branch: name, remote, ref: `refs/heads/${name}` };
    };
    let target: Pending;
    if (!branch) {
      if (!settings.saveDetachedHead || !settings.useInterimBranch || !initialHead) throw new Error("Detached HEAD: there is no branch to push. Check out a branch, or enable interim branches and “Save work from a detached HEAD”.");
      if (!dirty && (await git(root, ["for-each-ref", "--count=1", "--contains", "HEAD", "refs/remotes"])).trim()) return { outcome: "clean", message: `${resumed}Detached HEAD has no changes and is already on a remote branch` };
      target = await route(`detached-${initialHead.slice(0, 7)}`, (await pushTarget(root, "")).remote);
    } else {
      target = await pushTarget(root, branch);
      if (pending && JSON.stringify(pending) !== JSON.stringify(target)) throw new Error("A pending push belongs to a different remote or destination; restore it before retrying");
      const trackingHead = (await git(root, ["rev-parse", "--verify", `refs/remotes/${where(target)}`]).catch(() => "")).trim();
      // A clean worktree can still contain commits that were never pushed.
      if (!dirty && !pending && initialHead && trackingHead === initialHead) return { outcome: resumed ? "pushed" : "clean", message: `${resumed}No changes or unpushed commits on ${branch}` };
      if (isProtected(settings, target)) {
        if (!settings.useInterimBranch) throw new Error(`Work not pushed: ${branch} / ${target.ref} is protected and interim branches are disabled. Enable “Create and push to an interim branch” in Overcommitted settings, or push this work manually.`);
        if (pending && !settings.rerouteNewlyProtected) throw new Error("A pending push now targets a protected branch; push it manually, or enable “Send a waiting push to the interim branch”");
        target = await route(branch, target.remote);
      }
    }
    branch = target.branch;
    if (preview) return { outcome: "eligible", message: `${resumed}${dirty ? "Would stage and commit all non-ignored changes, then push" : pending ? "Would retry pending push" : "Would push existing commits"} ${branch} → ${where(target)}` };
    const check = async () => {
      if (signal?.aborted) throw new Error("Check cancelled");
      await guard();
      if ((await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() !== branch) throw new Error("Branch changed during check");
    };
    await check();
    if ((await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() !== initialHead) throw new Error("HEAD changed during check");
    // Journal the obligation even for a clean-but-unpushed branch or a failed
    // add/commit. Never remove it until the push succeeds.
    await journal(target);
    if (dirty) {
      await git(root, ["add", "--all", "--", "."], signal);
      const names = (await git(root, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
      if (!names.length) throw new Error("Changes cannot be staged (possibly a dirty submodule); leaving them untouched");
      const summary = await git(root, ["diff", "--cached", "--stat"]);
      const stagedTree = (await git(root, ["write-tree"])).trim();
      await check();
      if ((await git(root, ["write-tree"])).trim() !== stagedTree || (await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() !== initialHead) throw new Error("Index or HEAD changed before commit");
      await git(root, ["commit", "-m", commitMessage(names, summary, titles)], signal).catch(error => {
        const message = (error as Error).message;
        throw NOT_A_CHECK.test(message) ? error : new Resolvable(message, "precheck", stagedTree, message);
      });
    }
    let commit = await head(root);
    await check();
    if (await head(root) !== commit) throw new Error("HEAD moved before push");
    if (isProtected(settings, target)) throw new Error("Refusing to push a protected branch");
    try { await pushCommit(root, target, commit, signal); } catch (rejected) {
      const message = (rejected as Error).message;
      if (settings.rerouteServerProtected && settings.useInterimBranch && refusedAsProtected(message)) {
        const refused = where(target);
        target = await route(branch, target.remote);
        branch = target.branch;
        await journal(target);
        await pushCommit(root, target, commit, signal);
        await unlink(pendingPath);
        return { outcome: "pushed", message: `${resumed}${refused} is protected on the remote; pushed to ${where(target)} instead` };
      }
      const integrated = settings.mergeRemoteAhead ? await integrateRemote(root, target, commit, check, signal) : null;
      if (!integrated) throw rejected;
      if (integrated === "contained") {
        await unlink(pendingPath);
        return { outcome: "clean", message: `${resumed}${where(target)} already contains ${branch}` };
      }
      commit = integrated;
      await pushCommit(root, target, commit, signal);
    }
    await unlink(pendingPath);
    return { outcome: "pushed", message: `${resumed}Pushed ${branch} to ${where(target)}` };
  } finally { await lock.close(); await unlink(lockPath); }
}
