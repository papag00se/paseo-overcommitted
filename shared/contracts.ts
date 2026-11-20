import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { rulesError, type RuleKind } from "./rules";

const ruleCheck = (kind: RuleKind, label: string) => (text: string, ctx: z.RefinementCtx) => {
  const error = rulesError(text, kind);
  if (error) ctx.addIssue({ code: "custom", message: `${label}: ${error}` });
};

export const preferences = defineSettings({
  id: "overcommitted", scope: "host", version: 1,
  schema: z.object({
    // Off until the user turns it on: a sweep stages, commits and pushes, which must be a choice.
    enabled: z.boolean().default(false),
    intervalMinutes: z.number().int().min(1).max(10080).default(60),
    protectBranches: z.boolean().default(false),
    // Rule lines `<path-glob> [<branch-glob> ...]` (see shared/rules.ts). A legacy
    // list such as `main, master` still works and means `* main master`.
    protectedBranches: z.string().default("* main master").superRefine(ruleCheck("protected", "Protected branches")),
    useInterimBranch: z.boolean().default(true),
    interimPrefix: z.string().trim().min(1).default("overcommitted/<current branch name>"),
    // Rule lines; only path globs. Each matching known Paseo project/workspace
    // folder has its child Git repositories checked like registered ones.
    childRepoFolders: z.string().default("").superRefine(ruleCheck("folders", "Child repository folders")),
    // Rule lines: repositories (and branches) that are never checked or pushed to.
    excludedRepos: z.string().default("").superRefine(ruleCheck("excluded", "Never-check rules")),
    // Automatic fixes. Each is non-destructive; when one cannot be proven
    // safe, the failure is reported instead.
    mergeRemoteAhead: z.boolean().default(true),
    removeStaleLock: z.boolean().default(true),
    pushSwitchedBranch: z.boolean().default(true),
    agentResolve: z.boolean().default(false),
    agentModel: z.string().trim().default("claude/claude-sonnet-5"),
  }).refine(s => !s.agentResolve || /^[^/\s]+\/\S+$/.test(s.agentModel), { message: "Agent model must be provider/model, for example claude/claude-sonnet-5", path: ["agentModel"] }),
});
export type Preferences = z.output<typeof preferences.schema>;
export const reportSchema = z.object({
  at: z.string(), directory: z.string(), outcome: z.enum(["pushed", "clean", "skipped", "error", "eligible", "scanned"]), message: z.string(), warnings: z.array(z.string()).optional(),
});
export type Report = z.infer<typeof reportSchema>;
export const statusRpc = defineRpc({ name: "overcommitted.status", input: z.object({}), output: z.object({
  running: z.boolean(), nextCheck: z.string().nullable(), reports: z.array(reportSchema), failures: z.array(reportSchema),
}) });
export const dismissWarningsRpc = defineRpc({ name: "overcommitted.dismiss-warnings", input: z.object({ warnings: z.array(z.object({ directory: z.string(), at: z.string() })).min(1) }), output: z.object({ dismissed: z.number().int().nonnegative() }) });
export const checkRpc = defineRpc({ name: "overcommitted.check", input: z.object({ preview: z.boolean() }), output: z.object({ reports: z.array(reportSchema) }) });
