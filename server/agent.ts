import type { PaseoApi } from "@getpaseo/client";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./command";
import type { Preferences } from "../shared/contracts";

// A failure that needs judgment rather than a fixed rule. `key` identifies the
// exact situation so a finished agent is not asked to retry the same thing.
export class Resolvable extends Error {
  constructor(message: string, readonly kind: "conflict" | "precheck", readonly key: string, readonly detail: string) { super(message); }
}

const RULES = "Never push, force, reset, rebase, stash, bypass hooks (--no-verify), or delete or disable a check. Overcommitted pushes after you finish.";
export function agentPrompt(root: string, branch: string, failure: Resolvable): string {
  return failure.kind === "conflict"
    ? `Overcommitted could not push ${branch} in ${root}. ${failure.detail}\n\n1. Run \`git merge --no-ff ${failure.key.split(":")[1]}\`.\n2. Resolve every conflict so the intent of both sides survives. Read each side's history when unsure.\n3. Run the project's checks or tests if it has them.\n4. Commit the merge normally.\n\n${RULES}\nIf you cannot resolve a conflict confidently, run \`git merge --abort\` and explain why.`
    : `Overcommitted could not commit the idle changes in ${root} on ${branch}. A commit check (Git hook) failed:\n\n${failure.detail}\n\nThe changes are staged. Fix the problem the check reports, then \`git add -A\` and \`git commit\` normally.\n\n${RULES}\nIf code changes cannot fix it (for example a missing tool or credentials), stop and explain.`;
}

// Starts one agent per distinct failure. Returns a status message, or throws
// the original failure when an agent already tried this exact situation.
export async function requestAgent(api: PaseoApi, root: string, failure: Resolvable, settings: Preferences): Promise<string> {
  const marker = join((await git(root, ["rev-parse", "--absolute-git-dir"])).trim(), "overcommitted-agent.json");
  const previous = await readFile(marker, "utf8").then(JSON.parse, () => null) as { key: string; agentId: string } | null;
  if (previous?.key === failure.key) throw new Error(`${failure.message}\n\nAgent ${previous.agentId} already tried and could not finish. Resolve this manually.`);
  const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "HEAD")).trim();
  const title = `Overcommitted: ${failure.kind === "conflict" ? "resolve merge conflict" : "fix failed commit check"} on ${branch}`;
  const agent = await api.agents.create({ config: { provider: settings.agentModel }, cwd: root, title, prompt: agentPrompt(root, branch, failure) }).catch(error => {
    throw new Error(`${failure.message}\n\nCould not start an agent to resolve it: ${(error as Error).message}`);
  });
  await writeFile(`${marker}.tmp`, JSON.stringify({ key: failure.key, agentId: agent.id, at: new Date().toISOString() }), { mode: 0o600 });
  await rename(`${marker}.tmp`, marker);
  return `${title}: agent ${agent.id} started. Work is pushed after it finishes.`;
}
