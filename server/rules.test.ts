import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { git } from "./command";
import { checkpoint } from "./git";
import { sweepWithApi } from "./sweep";
import { checkerFor, compileRules, protectedChecker } from "./rules";
import { preferences } from "../shared/contracts";
import { matchBranches, matchPath, parseRules, rulesError } from "../shared/rules";

const defaults = preferences.schema.parse({});
const guard = async () => {};

test("parse: comments, blanks, quotes and branch globs; errors name the line and nothing is partially accepted", () => {
  const { rules, errors } = parseRules('\n# a comment\n  /home/me/a   main  !wip/* \n"/home/me/My Repos/b"\n/home/me/My\\ Repos/c release/**\n* \n', "excluded");
  assert.deepEqual(errors, []);
  assert.deepEqual(rules.map(r => [r.path, r.branches]), [
    ["/home/me/a", ["main", "!wip/*"]], ["/home/me/My Repos/b", []], ["/home/me/My Repos/c", ["release/**"]], ["*", []],
  ]);
  assert.equal(rules[0].line, "/home/me/a   main  !wip/*");
  for (const [text, kind, message] of [
    ["relative/path", "excluded", /Line 1: .*not a full path/],
    ["/ok\n~bob/x", "excluded", /Line 2: .*~user/],
    ["/a/../b", "excluded", /\.\./],
    ["/a [unclosed", "excluded", /Line 1: .*empty|unclosed/],
    ["/a x[", "excluded", /unclosed \[/],
    ["/a !", "excluded", /empty branch/],
    ['"/a b', "excluded", /unclosed quote/],
    ["/a main", "folders", /branch patterns are not used here/],
    ["*", "folders", /not a full path/],
    ["main, master\n/a x", "protected", /Line 1: .*not a full path/],
  ] as const) assert.match(rulesError(text, kind) ?? "", message, text);
  assert.equal(preferences.schema.safeParse({ excludedRepos: "/a\nbogus" }).success, false);
  assert.equal(preferences.schema.safeParse({ protectedBranches: "/a [x" }).success, false);
  assert.equal(preferences.schema.safeParse({ childRepoFolders: "/a main" }).success, false);
});

test("legacy protected list means every repository", () => {
  for (const text of ["main, master, agent", " main,master ,agent,\n", "main\nmaster agent"]) {
    const { rules, errors } = parseRules(text, "protected");
    assert.deepEqual(errors, []);
    assert.deepEqual(rules.map(r => [r.line, r.path, r.branches]), [["* main master agent", "*", ["main", "master", "agent"]]]);
  }
  assert.deepEqual(parseRules("main, master, agent", "protected").rules[0].branches, ["main", "master", "agent"]);
  assert.equal(parseRules("main, master, agent", "protected").rules[0].line, "* main master agent");
  assert.deepEqual(parseRules("", "protected").rules, []);
  assert.deepEqual(parseRules(" , ", "protected").rules, []);
  // The same list written as a rule behaves identically.
  assert.deepEqual(parseRules("* main master agent", "protected").rules[0].branches, ["main", "master", "agent"]);
});

test("branch globs: git-style wildcards, classes, case, negation", () => {
  for (const [globs, branch, expected] of [
    [[], "anything", true],
    [["main"], "main", true], [["main"], "Main", false], [["main"], "main2", false],
    [["release/*"], "release/1.0", true], [["release/*"], "release/1/x", false], [["release/**"], "release/1/x", true],
    [["feature/?"], "feature/a", true], [["feature/?"], "feature/ab", false],
    [["v[0-9]"], "v7", true], [["v[0-9]"], "vx", false], [["v[!0-9]"], "vx", true],
    [["*"], "a/b", false], [["**"], "a/b", true],
    [["!main"], "main", false], [["!main"], "feature", true], [["!main"], "", true],
    [["!main", "!master"], "dev", true], [["!main", "!master"], "master", false],
    [["release/*", "!release/old"], "release/new", true], [["release/*", "!release/old"], "release/old", false], [["release/*", "!release/old"], "main", false],
    [["*", "!main"], "feature", true], [["*", "!main"], "main", false],
  ] as const) assert.equal(matchBranches([...globs], branch), expected, `${globs.join(" ")} vs ${JSON.stringify(branch)}`);
});

test("path globs: *, **, ?, folder coverage, and exact matching for folders", () => {
  const covers = (pattern: string, path: string, ancestors = true) => matchPath([pattern], [path], ancestors);
  for (const [pattern, path, expected] of [
    ["/w/app", "/w/app", true], ["/w/app", "/w/app/sub/repo", true], ["/w/app", "/w/app2", false], ["/w/app", "/w", false],
    ["/w/*", "/w/a", true], ["/w/*", "/w/a/b", true], ["/w/*", "/w", false], ["/w/*", "/x/a", false],
    ["/w/a*", "/w/abc", true], ["/w/a*", "/w/b", false],
    ["/w/**", "/w", true], ["/w/**", "/w/a/b/c", true], ["/w/**/app", "/w/app", true], ["/w/**/app", "/w/x/y/app", true], ["/w/**/app", "/w/x/y/apps", false],
    ["/w/r?", "/w/r1", true], ["/w/r?", "/w/r12", false],
    ["/**", "/anything/at/all", true], ["/w/a.b", "/w/aXb", false], ["/w/[x]", "/w/[x]", true],
  ] as const) assert.equal(covers(pattern, path), expected, `${pattern} vs ${path}`);
  // Folder rules match the folder itself, not what is below it.
  assert.equal(covers("/w/*", "/w/a", false), true);
  assert.equal(covers("/w/*", "/w/a/b", false), false);
  assert.equal(covers("/w/app", "/w/app/sub", false), false);
});

test("compile: ~ expands, bare * covers every repository, first matching path line wins (not the first branch hit)", async () => {
  const rules = await compileRules("~/Work/special main\n~/Work/* !main\n* release\n", "excluded", "/home/me");
  const at = async (root: string) => (await checkerFor(rules, root)).rule?.line;
  assert.equal(await at("/home/me/Work/special"), "~/Work/special main");
  assert.equal(await at("/home/me/Work/special/nested"), "~/Work/special main");
  assert.equal(await at("/home/me/Work/other"), "~/Work/* !main");
  assert.equal(await at("/srv/else"), "* release");
  const special = await checkerFor(rules, "/home/me/Work/special");
  assert.equal(special.hits("main")?.line, "~/Work/special main");
  // The specific line matched this repository, so the broader `!main` line must not apply to it.
  assert.equal(special.hits("feature"), undefined);
  const other = await checkerFor(rules, "/home/me/Work/other");
  assert.equal(other.hits("feature")?.line, "~/Work/* !main");
  assert.equal(other.hits("main"), undefined);
  // Reversing the order lets the broad line win.
  const reversed = await checkerFor(await compileRules("~/Work/* !main\n~/Work/special main\n", "excluded", "/home/me"), "/home/me/Work/special");
  assert.equal(reversed.rule?.line, "~/Work/* !main");
});

test("symlink aliases: a rule naming an alias or its folder covers the real repository and vice versa", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "overcommitted-rules-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, "real", "repo"), { recursive: true });
  await symlink(join(base, "real"), join(base, "alias"));
  const viaAlias = await compileRules(`${base}/alias/repo\n`, "excluded");
  assert.ok((await checkerFor(viaAlias, join(base, "real", "repo"))).rule, "rule names the alias, repo reached by its real path");
  const viaAliasGlob = await compileRules(`${base}/alias/**\n`, "excluded");
  assert.ok((await checkerFor(viaAliasGlob, join(base, "real", "repo"))).rule);
  const viaReal = await compileRules(`${base}/real/repo\n`, "excluded");
  assert.ok((await checkerFor(viaReal, join(base, "alias", "repo"))).rule, "rule names the real path, repo reached through the alias");
  assert.equal((await checkerFor(await compileRules(`${base}/elsewhere\n`, "excluded"), join(base, "real", "repo"))).rule, undefined);
});

test("protected rules: scoped per repository, legacy list still applies everywhere, off when the toggle is off", async () => {
  const on = (protectedBranches: string) => preferences.schema.parse({ protectBranches: true, protectedBranches });
  const hits = async (s: typeof defaults, root: string, branch: string) => (await protectedChecker(s, root)).hits(branch)?.line;
  const scoped = on("/r/strict *\n/r/* main\n");
  assert.equal(await hits(scoped, "/r/strict", "feature"), "/r/strict *");
  assert.equal(await hits(scoped, "/r/loose", "main"), "/r/* main");
  assert.equal(await hits(scoped, "/r/loose", "feature"), undefined);
  assert.equal(await hits(scoped, "/elsewhere", "main"), undefined);
  assert.equal(await hits(on("main, master, agent"), "/anywhere", "agent"), "* main master agent");
  assert.equal(await hits(on("* !dev"), "/anywhere", "dev"), undefined);
  assert.equal(await hits(on("* !dev"), "/anywhere", "main"), "* !dev");
  assert.equal(await hits({ ...scoped, protectBranches: false }, "/r/strict", "feature"), undefined);
});

async function repo(t: { after: (fn: () => Promise<void>) => void }, branch = "main") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "overcommitted-rules-git-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "work"), remote = join(base, "remote.git");
  await mkdir(root); await git(base, ["init", "--bare", remote]);
  await git(root, ["init", "-b", branch]);
  await git(root, ["config", "user.email", "test@example.invalid"]); await git(root, ["config", "user.name", "Overcommitted Test"]);
  await writeFile(join(root, "base.txt"), "original\n");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "initial"]);
  await git(root, ["remote", "add", "origin", remote]); await git(root, ["push", "-u", "origin", branch]);
  await writeFile(join(root, "new.txt"), "work\n");
  const api = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) }, workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: [{ projectRootPath: root }] }) }, terminals: { list: async () => ({ entries: [] }) } } as unknown as PaseoApi;
  const sweep = (settings: typeof defaults, preview: boolean) => sweepWithApi(api, 2, settings, preview, new AbortController().signal, async () => []);
  const remoteHeads = async () => (await git(remote, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).trim().split("\n").sort();
  const untouched = async () => { assert.equal((await git(root, ["status", "--porcelain"])).trim(), "?? new.txt"); assert.equal((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), branch); };
  return { base, root, remote, sweep, remoteHeads, untouched };
}

test("never-check with branch globs skips only while the checked-out branch matches, naming the rule", async t => {
  const f = await repo(t);
  const rule = `${f.root} main release/*`;
  const skipped = await f.sweep({ ...defaults, excludedRepos: rule }, false);
  assert.deepEqual(skipped.map(r => [r.outcome, r.message]), [["skipped", `skipped: excluded by rule ${rule}`]]);
  await f.untouched();
  // `!main` = every branch except main: main is checked, other branches are skipped.
  const negated = `${f.root} !main`;
  assert.equal((await f.sweep({ ...defaults, excludedRepos: negated }, true))[0].outcome, "eligible");
  await git(f.root, ["switch", "-c", "feature"]);
  assert.equal((await f.sweep({ ...defaults, excludedRepos: negated }, true))[0].message, `skipped: excluded by rule ${negated}`);
  // No branch globs = all branches; a specific line above `*` overrides it.
  assert.equal((await f.sweep({ ...defaults, excludedRepos: `${f.root} main\n*` }, true))[0].outcome, "eligible");
  assert.equal((await f.sweep({ ...defaults, excludedRepos: `*` }, true))[0].message, "skipped: excluded by rule *");
});

test("a push whose target matches a never-check rule is refused before anything is staged, committed or pushed", async t => {
  // feature tracks origin/main: the checked-out branch is allowed, its destination is not.
  const f = await repo(t);
  await git(f.root, ["switch", "-c", "feature"]);
  await git(f.root, ["config", "branch.feature.remote", "origin"]); await git(f.root, ["config", "branch.feature.merge", "refs/heads/main"]);
  const settings = { ...defaults, excludedRepos: `${f.root} main` };
  const before = (await git(f.root, ["rev-parse", "HEAD"])).trim();
  await assert.rejects(checkpoint(f.root, [], guard, false, settings), /^Error: skipped: push target origin\/main excluded by rule .* main$/);
  assert.equal((await git(f.root, ["rev-parse", "HEAD"])).trim(), before);
  assert.equal((await git(f.root, ["status", "--porcelain"])).trim(), "?? new.txt");
  assert.deepEqual(await f.remoteHeads(), ["main"]);
  const [report] = await f.sweep(settings, false);
  assert.deepEqual([report.outcome, report.message], ["skipped", `skipped: push target origin/main excluded by rule ${f.root} main`]);
  // Without the rule the same work is pushed to that destination.
  assert.equal((await checkpoint(f.root, [], guard, false, defaults)).outcome, "pushed");
});

test("interim targets are refused too: protected main would route to overcommitted/main, which a rule forbids", async t => {
  const f = await repo(t);
  const settings = { ...defaults, protectBranches: true, protectedBranches: "main", excludedRepos: `${f.root} overcommitted/*` };
  for (const preview of [true, false]) {
    const [report] = await f.sweep(settings, preview);
    assert.equal(report.outcome, "skipped");
    assert.match(report.message, /^skipped: interim branch overcommitted\/main excluded by rule .* overcommitted\/\*$/);
    await f.untouched();
    assert.deepEqual(await f.remoteHeads(), ["main"]);
  }
  // Allowed target: the report names the protecting rule line.
  const rule = `${f.root} main`;
  const [ok] = await f.sweep({ ...defaults, protectBranches: true, protectedBranches: rule }, true);
  assert.equal(ok.outcome, "eligible");
  assert.match(ok.message, new RegExp(`→ origin/overcommitted/main \\(main is protected by rule ${f.root} main\\)$`));
});

test("child folders: a glob selects among known Paseo folders only; a literal unknown folder is still reported", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "overcommitted-folders-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const projects = ["Work/a", "Work/b", "Other/c"].map(p => join(base, p));
  for (const p of projects) { await mkdir(p, { recursive: true }); await mkdir(join(p, "repo", ".git"), { recursive: true }); }
  await mkdir(join(base, "Work", "unknown", "repo", ".git"), { recursive: true });
  const api = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) }, workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: projects.map(projectRootPath => ({ projectRootPath })) }) }, terminals: { list: async () => ({ entries: [] }) } } as unknown as PaseoApi;
  const run = (childRepoFolders: string) => sweepWithApi(api, 2, { ...defaults, childRepoFolders }, true, new AbortController().signal, async () => []);
  const scanned = (reports: Awaited<ReturnType<typeof run>>) => reports.filter(r => r.outcome === "scanned").map(r => r.directory).sort();
  const glob = await run(`${base}/Work/*`);
  assert.deepEqual(scanned(glob), [join(base, "Work", "a"), join(base, "Work", "b")], "Work/unknown is not a Paseo folder");
  assert.match(glob.find(r => r.outcome === "scanned")!.message, /\(rule .*Work\/\*\)$/);
  assert.deepEqual(scanned(await run(`${base}/**`)), projects.sort());
  assert.deepEqual(scanned(await run(`${base}/Other/c\n${base}/Work/a`)), [join(base, "Other", "c"), join(base, "Work", "a")]);
  const nothing = await run(`${base}/Work/zzz*\n${base}/Work/unknown`);
  assert.deepEqual(scanned(nothing), []);
  assert.equal(nothing.filter(r => /Not a known Paseo project or workspace/.test(r.message)).length, 2);
});
