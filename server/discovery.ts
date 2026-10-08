import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const CHILD_REPO_DEPTH = 4;
const SKIP = new Set(["node_modules"]);

/** Newline-delimited absolute folder paths; blank lines ignored. */
export function childRepoFolders(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => resolve(line)))];
}

/**
 * Candidate repository roots below `folder`: directories containing `.git`
 * (directory or worktree file). Does not descend into repositories, hidden
 * directories, node_modules or symlinks. Callers confirm each with Git.
 */
export async function findChildRepositories(folder: string, signal?: AbortSignal, maxDepth = CHILD_REPO_DEPTH): Promise<string[]> {
  const found: string[] = [];
  let level = [folder];
  for (let depth = 1; depth <= maxDepth && level.length && !signal?.aborted; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
        if (dir === folder) throw error;
        return [];
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        const path = join(dir, entry.name);
        const children = await readdir(path, { withFileTypes: true }).catch(() => []);
        if (children.some(c => c.name === ".git" && (c.isDirectory() || c.isFile()))) found.push(path);
        else next.push(path);
      }
    }
    level = next;
  }
  return found.sort();
}
