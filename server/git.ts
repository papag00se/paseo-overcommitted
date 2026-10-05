import { access, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./command";
import { protectedNames, selectInterim } from "./branches";
import type { Preferences } from "../shared/contracts";

interface Pending { branch: string; remote: string; ref: string }
async function exists(path: string) { try { await access(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
async function config(root: string, key: string) {
  // --get exits 1 for absent keys; --get-regexp isn't necessary for exact names.
  const all = (await git(root, ["config", "--null", "--list"])).split("\0");
  return all.filter(s => s.slice(0, s.indexOf("\n")) === key).at(-1)?.split("\n").slice(1).join("\n") ?? "";
}
export async function pushTarget(root: string, branch: string): Promise<Pending> {
  const remotes = (await git(root, ["remote"])).trim().split("\n").filter(Boolean);
  const upstream = await config(root, `branch.${branch}.remote`);
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
export interface GitResult { outcome: "pushed" | "clean" | "eligible"; message: string }
export async function checkpoint(root: string, titles: string[], guard: () => Promise<void>, preview: boolean, settings: Preferences, signal?: AbortSignal): Promise<GitResult> {
  const common = (await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const dir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
  const lockPath = join(common, "overcommitted.lock");
  const lock = await open(lockPath, "wx").catch(() => { throw new Error(`Repository already locked; inspect ${lockPath} before removing a stale lock`); });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), root }));
    const pendingPath = join(dir, "overcommitted-pending.json");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG", "index.lock"]) {
      if (await exists(join(dir, marker))) throw new Error(`Git operation in progress (${marker})`);
    }
    if ((await git(root, ["ls-files", "-u"])).trim()) throw new Error("Unmerged paths");
    let branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    let target = await pushTarget(root, branch);
    const initialHead = (await git(root, ["rev-parse", "--verify", "HEAD" ]).catch(() => "")).trim();
    const porcelain = await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if (porcelain.split("\0").some(line => /^[12] /.test(line) && /^S/.test(line.split(" ")[2]))) throw new Error("Submodule changes require a separate commit/push; refusing a partial checkpoint");
    const dirty = porcelain.length > 0;
    let pending: Pending | null = null;
    if (await exists(pendingPath)) {
      pending = JSON.parse(await readFile(pendingPath, "utf8"));
      if (JSON.stringify(pending) !== JSON.stringify(target)) throw new Error("A pending push belongs to a different branch or remote; restore it before retrying");
    }
    const trackingRef = `refs/remotes/${target.remote}/${target.ref.slice("refs/heads/".length)}`;
    const trackingHead = (await git(root, ["rev-parse", "--verify", trackingRef]).catch(() => "")).trim();
    // A clean worktree can still contain commits that were never pushed.
    if (!dirty && !pending && initialHead && trackingHead === initialHead) return { outcome: "clean", message: `No changes or unpushed commits on ${branch}` };
    const protectedSet = protectedNames(settings);
    if (protectedSet.has(branch) || protectedSet.has(target.ref.replace(/^refs\/heads\//, ""))) {
      if (!settings.useInterimBranch) throw new Error(`Work not pushed: ${branch} / ${target.ref} is protected and interim branches are disabled. Enable “Create and push to an interim branch” in Overcommitted settings, or push this work manually.`);
      if (pending) throw new Error("Pending push is now protected; resolve its journal manually before redirecting");
      const interim = await selectInterim(root, branch, target.remote, settings, guard, preview);
      branch = interim;
      target = { branch, remote: target.remote, ref: `refs/heads/${branch}` };
      if (!preview) {
        await git(root, ["config", "--local", `branch.${branch}.remote`, target.remote]);
        await git(root, ["config", "--local", `branch.${branch}.merge`, target.ref]);
      }
    }
    if (preview) return { outcome: "eligible", message: `${dirty ? "Would stage and commit all non-ignored changes, then push" : pending ? "Would retry pending push" : "Would push existing commits"} ${branch} → ${target.remote}/${target.ref}` };
    const check = async () => {
      if (signal?.aborted) throw new Error("Check cancelled");
      await guard();
      if ((await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() !== branch) throw new Error("Branch changed during check");
    };
    await check();
    if ((await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() !== initialHead) throw new Error("HEAD changed during check");
    // Journal the obligation even for a clean-but-unpushed branch or a failed
    // add/commit. Never remove it until the push succeeds.
    await writeFile(`${pendingPath}.tmp`, JSON.stringify(target), { mode: 0o600 });
    await rename(`${pendingPath}.tmp`, pendingPath);
    if (dirty) {
      await git(root, ["add", "--all", "--", "."], signal);
      const names = (await git(root, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
      if (!names.length) throw new Error("Changes cannot be staged (possibly a dirty submodule); leaving them untouched");
      const summary = await git(root, ["diff", "--cached", "--stat"]);
      const stagedTree = (await git(root, ["write-tree"])).trim();
      await check();
      if ((await git(root, ["write-tree"])).trim() !== stagedTree || (await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() !== initialHead) throw new Error("Index or HEAD changed before commit");
      await git(root, ["commit", "-m", commitMessage(names, summary, titles)], signal);
    }
    const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
    await check();
    if ((await git(root, ["rev-parse", "HEAD"])).trim() !== commit) throw new Error("HEAD moved before push");
    // Explicit refspec: ignores push.default, push refspecs, and matching-branch config.
    // No force, pull, rebase, reset, stash, or hook bypass.
    if (protectedSet.has(branch) || protectedSet.has(target.ref.replace(/^refs\/heads\//, ""))) throw new Error("Refusing to push a protected branch");
    await git(root, ["-c", "push.followTags=false", "-c", `remote.${target.remote}.mirror=false`, "push", "--porcelain", "--", target.remote, `${commit}:${target.ref}`], signal);
    await unlink(pendingPath);
    return { outcome: "pushed", message: `Pushed ${branch} to ${target.remote}/${target.ref}` };
  } finally { await lock.close(); await unlink(lockPath); }
}
