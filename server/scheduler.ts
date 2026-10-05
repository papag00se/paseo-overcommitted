import type { Preferences, Report } from "../shared/contracts";
import type { StatusStore } from "./status";

export class Scheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private active?: Promise<Report[]>;
  private settings?: Preferences;
  private stopped = false;
  nextCheck: string | null = null;
  reports: Report[] = [];
  constructor(private perform: (settings: Preferences, preview: boolean, signal: AbortSignal) => Promise<Report[]>, private status?: StatusStore) {}
  get failures() { return this.status?.visibleFailures ?? this.reports.filter(r => r.outcome === "error"); }
  async restore() { if (this.status) { await this.status.load(); this.reports = this.status.reports; } }
  get running() { return !!this.active; }
  configure(settings: Preferences) {
    this.settings = settings;
    this.controller?.abort();
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.nextCheck = null;
    if (this.stopped || !this.settings?.enabled || this.active) return;
    const delay = this.settings.intervalMinutes * 60_000;
    this.nextCheck = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => { void this.run(false).catch(e => console.error("Overcommitted check failed", e)); }, delay);
  }
  async run(preview: boolean): Promise<Report[]> {
    if (this.stopped) throw new Error("Plugin is stopping");
    if (this.active) throw new Error("A check is already running");
    if (!this.settings) throw new Error("Settings have not loaded");
    if (!preview && !this.settings.enabled) throw new Error("Automatic committing is disabled");
    clearTimeout(this.timer);
    this.nextCheck = null;
    this.controller = new AbortController();
    this.active = this.perform(this.settings, preview, this.controller.signal);
    try {
      this.reports = await this.active;
      await this.status?.record(this.reports, preview);
      for (const report of this.reports) (report.outcome === "error" ? console.error : report.warnings?.length ? console.warn : console.log)(JSON.stringify(report));
      return this.reports;
    } catch (e) {
      this.reports = [{ at: new Date().toISOString(), directory: "daemon", outcome: "error", message: (e as Error).message }];
      await this.status?.record(this.reports, preview).catch(error => console.error("Cannot persist Overcommitted failure status", error));
      throw e;
    } finally {
      this.active = undefined;
      this.controller = undefined;
      this.schedule();
    }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.nextCheck = null;
    this.controller?.abort();
    await this.active?.catch(() => {});
  }
}
