import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Preferences } from "../shared/contracts";
import { literalPrefix, matchBranches, matchPath, normalizePattern, parseRules, type Rule, type RuleKind } from "../shared/rules";

/** A rule plus the path patterns it matches: as written, and through its symlinked folder. */
export interface CompiledRule extends Rule { patterns: string[] }

/** Raised for a refused check or push; reported as skipped, never as a failure. */
export class Excluded extends Error {}

export async function compileRules(text: string, kind: RuleKind, home = homedir()): Promise<CompiledRule[]> {
  const { rules, errors } = parseRules(text, kind);
  if (errors.length) throw new Error(errors.join("; "));
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    const pattern = normalizePattern(rule.path, home);
    const patterns = [pattern];
    // A listed alias (symlink) also names the folder it points to.
    const prefix = literalPrefix(pattern);
    const real = await realpath(prefix).catch(() => null);
    if (real && real !== prefix) patterns.push(real + pattern.slice(prefix.length));
    compiled.push({ ...rule, patterns });
  }
  return compiled;
}

/** The repository's path as resolved, plus its realpath (symlink aliases). */
export async function repoPaths(root: string): Promise<string[]> {
  return [...new Set([resolve(root), await realpath(root).catch(() => resolve(root))])];
}

export interface RuleCheck {
  /** First rule whose path matches this repository (it alone decides, later lines are ignored). */
  rule?: CompiledRule;
  /** That rule, when it also covers `branch`. */
  hits(branch: string): CompiledRule | undefined;
}
export async function checkerFor(rules: CompiledRule[], root: string): Promise<RuleCheck> {
  const paths = await repoPaths(root);
  const rule = rules.find(r => matchPath(r.patterns, paths, true));
  return { rule, hits: branch => rule && matchBranches(rule.branches, branch) ? rule : undefined };
}

const NEVER: RuleCheck = { hits: () => undefined };
export async function excludedChecker(settings: Preferences, root: string): Promise<RuleCheck> {
  return checkerFor(await compileRules(settings.excludedRepos, "excluded"), root);
}
/** Protected-branch rules apply only while the toggle is on. */
export async function protectedChecker(settings: Preferences, root: string): Promise<RuleCheck> {
  return settings.protectBranches ? checkerFor(await compileRules(settings.protectedBranches, "protected"), root) : NEVER;
}
