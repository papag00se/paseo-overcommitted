// One rule syntax for the three path/branch settings, parsed and matched here
// only. Pure (no Node imports) so the settings editor validates on save with
// the same code the daemon uses.
//
//   <path-glob> [<branch-glob> ...]       one rule per line; # starts a comment line
//
// Quote a path containing spaces: "/home/me/My Repos/app" main

export type RuleKind = "excluded" | "protected" | "folders";
export interface Rule {
  /** The rule as written (or its canonical form for a legacy branch list); shown in reports. */
  line: string;
  /** Path glob exactly as written, unquoted. `*` alone means every repository. */
  path: string;
  /** Branch globs; `!glob` negates. Empty means every branch. */
  branches: string[];
}
export interface ParsedRules { rules: Rule[]; errors: string[] }

const escapeChar = (c: string) => c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/**
 * Glob → regular-expression source. `*` and `?` stay within one `/` segment,
 * `**` crosses segments, `[...]` is a character class (branch globs only).
 */
function globSource(glob: string, classes: boolean): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      let j = i;
      while (glob[j + 1] === "*") j++;
      if (j > i) {
        // `**/` matches whole segments (including none); other `**` matches anything.
        if (glob[j + 1] === "/" && (i === 0 || glob[i - 1] === "/")) { out += "(?:.*/)?"; i = j + 1; }
        else { out += ".*"; i = j; }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[" && classes) {
      let j = i + 1;
      if (glob[j] === "!" || glob[j] === "^") j++;
      if (glob[j] === "]") j++;
      while (j < glob.length && glob[j] !== "]") j++;
      if (j >= glob.length) throw new Error(`unclosed [ in “${glob}”`);
      const body = glob.slice(i + 1, j);
      const negated = body[0] === "!" || body[0] === "^";
      const set = (negated ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&");
      out += `[${negated ? "^" : ""}${set}]`;
      i = j;
    } else out += escapeChar(c);
  }
  return out;
}

// ---- Branch globs ---------------------------------------------------------

export function validateBranchGlob(glob: string): string | null {
  const body = glob.startsWith("!") ? glob.slice(1) : glob;
  if (!body) return "an empty branch pattern";
  try { new RegExp(`^${globSource(body, true)}$`); return null; } catch (e) { return (e as Error).message; }
}

/**
 * A branch matches a list when it matches at least one positive glob (or the
 * list has only `!` globs) and matches no `!` glob. `!main` = every branch but
 * main. An empty list = every branch. Case-sensitive.
 */
export function matchBranches(globs: string[], branch: string): boolean {
  if (!globs.length) return true;
  const test = (g: string) => new RegExp(`^${globSource(g, true)}$`, "s").test(branch);
  const positive = globs.filter(g => !g.startsWith("!")), negative = globs.filter(g => g.startsWith("!")).map(g => g.slice(1));
  return (!positive.length || positive.some(test)) && !negative.some(test);
}

// ---- Path globs -----------------------------------------------------------

export const hasGlob = (path: string) => /[*?]/.test(path);

/** Expands `~`, drops trailing slashes; a lone `*` or `**` becomes `/**` (every path). */
export function normalizePattern(path: string, home: string): string {
  if (path === "*" || path === "**") return "/**";
  const expanded = path === "~" ? home : path.startsWith("~/") ? home.replace(/\/+$/, "") + path.slice(1) : path;
  return expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded;
}

/**
 * True when a candidate matches a normalized pattern. A trailing `/**` also
 * matches the folder itself. With `ancestors`, a candidate also matches when
 * any folder above it does, so a path rule covers everything below that folder.
 */
export function matchPath(patterns: string[], candidates: string[], ancestors: boolean): boolean {
  return patterns.some(pattern => {
    const deep = pattern.endsWith("/**");
    const source = globSource(deep ? pattern.slice(0, -3) : pattern, false);
    const re = new RegExp(`^${source}${deep || ancestors ? "(?:/.*)?" : ""}$`, "s");
    return candidates.some(c => re.test(c));
  });
}

/** Leading folder of a pattern that has no wildcards, for resolving symlinked aliases. */
export function literalPrefix(pattern: string): string {
  const segments = pattern.split("/"), literal: string[] = [];
  for (const s of segments) { if (hasGlob(s)) break; literal.push(s); }
  return literal.join("/") || "/";
}

// ---- Parsing --------------------------------------------------------------

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "", started = false, quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = ""; else current += c; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === "\\" && /[\s"'\\]/.test(line[i + 1] ?? "")) { current += line[++i]; started = true; }
    else if (/\s/.test(c)) { if (started) { tokens.push(current); current = ""; started = false; } }
    else { current += c; started = true; }
  }
  if (quote) throw new Error("unclosed quote");
  if (started) tokens.push(current);
  return tokens;
}

function pathError(path: string, kind: RuleKind): string | null {
  if (kind !== "folders" && (path === "*" || path === "**")) return null;
  if (path.startsWith("~") && path !== "~" && !path.startsWith("~/")) return "“~user” is not supported; use ~ or a full path";
  if (!path.startsWith("/") && path !== "~" && !path.startsWith("~/")) return `“${path}” is not a full path (start with / or ~)${kind === "folders" ? "" : ", or use * for every repository"}`;
  if (path.split("/").some(s => s === ".." || s === ".")) return `“${path}” must not contain . or .. folders`;
  try { globSource(path, false); } catch (e) { return (e as Error).message; }
  return null;
}

const PATH_START = /^(?:[/~*"']|\\)/;
/** An old-style list such as `main, master`: no line starts with a path. */
function legacyNames(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (!lines.length || lines.some(l => PATH_START.test(l))) return null;
  return lines.flatMap(l => l.split(/[,\s]+/)).filter(Boolean);
}

/** Parses a rules field. Errors name the line; nothing is accepted partially. */
export function parseRules(text: string, kind: RuleKind): ParsedRules {
  const rules: Rule[] = [], errors: string[] = [];
  if (kind === "protected") {
    const names = legacyNames(text);
    if (names) {
      if (!names.length) return { rules, errors }; // only separators: nothing protected, as before
      const bad = names.map(validateBranchGlob).find(Boolean);
      return bad ? { rules, errors: [`Branch names: ${bad}`] } : { rules: [{ line: `* ${names.join(" ")}`, path: "*", branches: names }], errors };
    }
  }
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const fail = (message: string) => errors.push(`Line ${index + 1}: ${message}`);
    let tokens: string[];
    try { tokens = tokenize(line); } catch (e) { return fail((e as Error).message); }
    const [path, ...branches] = tokens;
    const problem = pathError(path, kind) ?? (kind === "folders" && branches.length ? "branch patterns are not used here; list only folders" : null) ?? branches.map(validateBranchGlob).find(Boolean) ?? null;
    if (problem) return fail(problem);
    rules.push({ line, path, branches });
  });
  return { rules, errors };
}

/** Save-time validation message for a field, or null when valid. */
export function rulesError(text: string, kind: RuleKind): string | null {
  const { errors } = parseRules(text, kind);
  return errors.length ? errors.join("; ") : null;
}
