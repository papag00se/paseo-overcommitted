import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "overcommitted", scope: "host", version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().int().min(1).max(10080).default(60),
    protectBranches: z.boolean().default(false),
    protectedBranches: z.string().default("main, master"),
    useInterimBranch: z.boolean().default(true),
    interimPrefix: z.string().trim().min(1).default("overcommitted/<current branch name>"),
    // Newline-delimited absolute paths of known Paseo project/workspace folders
    // whose child Git repositories are checked like registered ones.
    childRepoFolders: z.string().default("").refine(
      text => text.split(/\r?\n/).map(line => line.trim()).every(line => !line || line.startsWith("/")),
      "Child repository folders must be full paths, one per line"),
  }),
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
