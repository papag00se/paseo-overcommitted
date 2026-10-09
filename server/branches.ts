import { git } from "./command";
import type { Preferences } from "../shared/contracts";

export function protectedNames(settings: Preferences): Set<string> {
  return new Set(settings.protectBranches ? settings.protectedBranches.split(",").map(s => s.trim()).filter(Boolean) : []);
}
export function interimName(template: string, branch: string): string {
  return template.includes("<current branch name>")
    ? template.replaceAll("<current branch name>", branch)
    : `${template.replace(/\/+$/, "")}/${branch}`;
}
export async function selectInterim(root: string, source: string, remote: string, settings: Preferences, guard: () => Promise<void>, preview: boolean): Promise<string> {
  const base = interimName(settings.interimPrefix, source);
  await git(root, ["check-ref-format", "--branch", base]);
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  // `source` names the work (a branch, or a label for a detached HEAD).
  const current = () => git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(s => s.trim(), () => "");
  const checkedOut = await current();
  const local = new Map((await git(root, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"]))
    .trim().split("\n").filter(Boolean).map(line => line.split(" ") as [string, string]));
  const remoteRefs = new Map((await git(root, ["ls-remote", "--heads", "--", remote])).trim().split("\n").filter(Boolean)
    .map(line => { const [oid, ref] = line.split("\t"); return [ref.replace(/^refs\/heads\//, ""), oid]; }));
  const occupied = new Set((await git(root, ["worktree", "list", "--porcelain"])).split("\n").filter(s => s.startsWith("branch refs/heads/")).map(s => s.slice(18)));
  const protectedSet = protectedNames(settings);
  for (let ordinal = 1; ordinal <= 1000; ordinal++) {
    const name = ordinal === 1 ? base : `${base}-${ordinal}`;
    if (protectedSet.has(name) || occupied.has(name)) continue;
    // Git cannot have both refs/heads/foo and refs/heads/foo/bar.
    if ([...local.keys(), ...remoteRefs.keys()].some(n => n !== name && (n.startsWith(`${name}/`) || name.startsWith(`${n}/`)))) continue;
    let compatible = true;
    const remoteOid = remoteRefs.get(name);
    if (remoteOid && !preview) {
      // Fetch only the candidate, never merge/pull or rewrite a remote-tracking branch.
      await git(root, ["fetch", "--no-tags", "--no-write-fetch-head", "--", remote, `refs/heads/${name}`]);
    }
    for (const oid of [local.get(name), remoteOid].filter((v): v is string => !!v)) {
      try { await git(root, ["merge-base", "--is-ancestor", oid, head]); }
      catch { compatible = false; break; }
    }
    if (!compatible) continue;
    if (preview) return name;
    await guard();
    if (await current() !== checkedOut || (await git(root, ["rev-parse", "HEAD"])).trim() !== head) throw new Error("Source branch moved while selecting interim branch");
    if (local.has(name)) {
      // Compare-and-swap a proven fast-forward of a branch not checked out anywhere.
      // Its new tree equals our current HEAD, so ordinary switch preserves dirty files.
      await git(root, ["update-ref", "-m", "overcommitted: fast-forward interim branch", `refs/heads/${name}`, head, local.get(name)!]);
      await git(root, ["switch", "--no-guess", name]);
    } else {
      await git(root, ["switch", "--no-track", "--create", name, head]);
    }
    return name;
  }
  throw new Error("Cannot find an available interim branch among the first 1000 ordinals");
}
