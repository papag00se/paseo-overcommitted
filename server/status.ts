import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { reportSchema, type Report } from "../shared/contracts";

const identity = z.object({ directory: z.string(), at: z.string() });
const schema = z.object({ reports: z.array(reportSchema), failures: z.array(reportSchema), dismissed: z.array(identity).default([]) });
type WarningIdentity = z.infer<typeof identity>;
const same = (a: WarningIdentity, b: WarningIdentity) => a.directory === b.directory && a.at === b.at;

// Status metadata only. Dismissal acknowledges a particular warning, never the
// repository's pending Git work. A subsequent failed attempt appears again.
export class StatusStore {
  reports: Report[] = [];
  failures: Report[] = [];
  private dismissed: WarningIdentity[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private path = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "overcommitted-status.json")) {}
  get visibleFailures() { return this.failures.filter(f => !this.dismissed.some(d => same(d, f))); }
  async load() {
    try {
      const state = schema.parse(JSON.parse(await readFile(this.path, "utf8")));
      this.reports = state.reports; this.failures = state.failures; this.dismissed = state.dismissed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        this.failures = [{ at: new Date().toISOString(), directory: "status", outcome: "error", message: `Cannot load prior push status: ${(e as Error).message}` }];
      }
    }
  }
  private update<T>(change: () => T): Promise<T> {
    const operation = this.writes.then(async () => {
      const previous = { reports: this.reports, failures: this.failures, dismissed: this.dismissed };
      const result = change();
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(`${this.path}.tmp`, JSON.stringify({ reports: this.reports, failures: this.failures, dismissed: this.dismissed }), { mode: 0o600 });
        await rename(`${this.path}.tmp`, this.path);
      } catch (error) {
        // A failed dismissal must not silently hide a warning in memory.
        this.reports = previous.reports; this.failures = previous.failures; this.dismissed = previous.dismissed;
        throw error;
      }
      return result;
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  async record(reports: Report[], preview: boolean) {
    if (preview) { this.reports = reports; return; }
    await this.update(() => {
      this.reports = reports;
      const failures = new Map(this.failures.map(r => [r.directory, r]));
      for (const report of reports) {
        if (report.outcome === "error") failures.set(report.directory, report);
        else if (report.outcome === "pushed" || report.outcome === "clean") failures.delete(report.directory);
      }
      if (reports.length && !reports.some(r => r.directory === "daemon" && r.outcome === "error")) failures.delete("daemon");
      this.failures = [...failures.values()];
      this.dismissed = this.dismissed.filter(d => this.failures.some(f => same(d, f)));
    });
  }
  dismiss(warnings: WarningIdentity[]) {
    return this.update(() => {
      const matches = this.visibleFailures.filter(f => warnings.some(w => same(w, f)));
      this.dismissed = [...this.dismissed, ...matches.map(({ directory, at }) => ({ directory, at }))];
      return matches.length;
    });
  }
}
